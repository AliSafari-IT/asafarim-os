#!/usr/bin/env node
/**
 * `pnpm e2e` (P3.2, P3.3a): the notes acceptance flows in a real browser.
 *   compose up (Postgres, Redis, the dev gateway) → bootstrap → identity + core-api (with a short
 *   access-token lifetime, so the revocation bound is tested for real) + dev login stub →
 *   install notes (NOT activated: the tests do that) → build and start notes →
 *   the Admin console (build and start) →
 *   Playwright: notes.spec.ts (direct) and gateway.spec.ts (through http://notes.localhost:8080) in
 *   apps/notes, then admin.spec.ts (the console at http://core.localhost:8080, P3.3b) in core/admin →
 *   stop everything. `--down` also removes the dev volumes (CI).
 *
 * First time on a machine: `pnpm --filter @asafarim/notes exec playwright install chromium`.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { bootstrap, readEnvFile } from "./bootstrap.mjs";
import { installDevApps } from "./apps.mjs";
import {
  bold,
  buildWorkspaceDependencies,
  checkGatewayEnv,
  compose,
  dbEnv,
  green,
  red,
  requireDocker,
  waitFor,
  waitForGateway,
} from "./infra.mjs";
import { DEV, DEV_DIR, ISSUER, ROOT, ensureDevKeys } from "./keys.mjs";

const NOTES_DIR = path.join(ROOT, "apps/notes");
const ADMIN_DIR = path.join(ROOT, "core/admin");
const ADMIN_URL = `http://localhost:${DEV.adminPort}`;
const ADMIN_GATEWAY_URL = `http://core.localhost:${DEV.gatewayPort}`;
const NOTES_URL = `http://localhost:${DEV.apps.notes}`;
const GATEWAY_URL = `http://notes.localhost:${DEV.gatewayPort}`;
// Access tokens live this long in the e2e (production: 60 s); the gateway spec asserts against it.
const TOKEN_TTL = Number(process.env.E2E_TOKEN_TTL ?? 6);
const children = [];

function start(name, args, cwd = ROOT, env = process.env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

const service = (name, envFile, entry, env = process.env) =>
  start(name, [`--env-file=${path.join(DEV_DIR, envFile)}`, path.join(ROOT, entry)], ROOT, env);

let exitCode = 1;
try {
  requireDocker();
  ensureDevKeys();
  buildWorkspaceDependencies();
  checkGatewayEnv();
  compose("up", "-d", "--wait");
  await bootstrap(dbEnv());

  service("identity", "identity.env", "core/identity/src/server.ts");
  service("core-api", "core-api.env", "core/core-api/src/server.ts", {
    ...process.env,
    CORE_API_ACCESS_TOKEN_TTL_SECONDS: String(TOKEN_TTL),
  });
  service("dev-hub", "dev-hub.env", "tools/dev-hub/src/server.ts");
  await waitFor(`${ISSUER}/readyz`);
  await waitFor(`http://localhost:${DEV.coreApiPort}/readyz`);
  await waitFor(`http://localhost:${DEV.devHubPort}/healthz`);
  console.log(`${green("✔")} identity, core-api and the dev login stub are ready`);

  await installDevApps({ activate: false });

  const next = path.join(NOTES_DIR, "node_modules/next/dist/bin/next");
  console.log(bold("Building notes…"));
  const build = spawnSync(process.execPath, [next, "build"], { cwd: NOTES_DIR, stdio: "inherit" });
  if (build.status !== 0) throw new Error("next build failed");
  start("notes", [next, "start", "--port", String(DEV.apps.notes)], NOTES_DIR);
  await waitFor(`${NOTES_URL}/api/health`);
  console.log(`${green("✔")} notes is up at ${NOTES_URL}`);
  // The whole gateway chain: Caddy → core-api's /authz/check (installed but not active → 503).
  await waitForGateway(DEV.gatewayPort, `notes.localhost:${DEV.gatewayPort}`, "/api/health", 503);
  console.log(`${green("✔")} the gateway answers for notes at ${GATEWAY_URL}`);

  // The Admin console (P3.3b): a core service on its own port and its own gateway host.
  console.log(bold("Building the Admin console…"));
  const adminNext = path.join(ADMIN_DIR, "node_modules/next/dist/bin/next");
  const adminBuild = spawnSync(process.execPath, [adminNext, "build"], { cwd: ADMIN_DIR, stdio: "inherit" });
  if (adminBuild.status !== 0) throw new Error("next build (admin) failed");
  start("admin", [adminNext, "start", "--port", String(DEV.adminPort)], ADMIN_DIR);
  await waitFor(`${ADMIN_URL}/api/health`);
  await waitForGateway(DEV.gatewayPort, `core.localhost:${DEV.gatewayPort}`, "/api/health", 200);
  console.log(`${green("✔")} the Admin console is up at ${ADMIN_URL} and at ${ADMIN_GATEWAY_URL}`);

  const core = readEnvFile(path.join(DEV_DIR, "core-api.env"));
  const e2eEnv = {
    ...process.env,
    E2E_BASE_URL: NOTES_URL,
    E2E_GATEWAY_URL: GATEWAY_URL,
    E2E_ADMIN_URL: ADMIN_GATEWAY_URL,
    E2E_TOKEN_TTL: String(TOKEN_TTL),
    E2E_CORE_API_URL: core.CORE_API_URL,
    E2E_ADMIN_TOKEN: core.CORE_API_ADMIN_TOKEN,
    // notes' registry credential, for the console spec's launcher check (the spec reads no files).
    E2E_NOTES_CREDENTIAL: readEnvFile(path.join(DEV_DIR, "notes.env")).ASAFARIM_REGISTRY_CREDENTIAL,
    // The "migration needed" test simulates an app upgrade that deprecated a permission, in core-api's database.
    E2E_CORE_DATABASE_URL: core.CORE_API_DATABASE_URL,
    // The hand-off spec plays Hub in the browser: it signs assertions with the dev stub's key (#40).
    E2E_ISSUER: ISSUER,
    E2E_HUB_ASSERTION_PRIVATE_JWK: readEnvFile(path.join(DEV_DIR, "dev-hub.env")).DEV_HUB_ASSERTION_PRIVATE_JWK,
  };
  // Both suites always run (they share the stack, one after the other); the exit code is the first failure.
  const results = ["@asafarim/notes", "@asafarim/admin"].map((pkg) => {
    const run = spawnSync("pnpm", ["--filter", pkg, "e2e"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: e2eEnv,
    });
    return run.status ?? 1;
  });
  exitCode = results.find((code) => code !== 0) ?? 0;
  console.log(exitCode === 0 ? green(bold("\ne2e: OK")) : red(bold("\ne2e: FAILED")));
} catch (err) {
  console.error(red(`\ne2e setup FAILED: ${err.message}`));
} finally {
  for (const c of children) c.kill();
  if (process.argv.includes("--down")) compose("down", "--volumes", "--remove-orphans");
}
process.exit(exitCode);
