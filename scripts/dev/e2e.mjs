#!/usr/bin/env node
/**
 * `pnpm e2e` (P3.2): the notes acceptance flow in a real browser.
 *   compose up → bootstrap → identity + core-api + dev login stub →
 *   install notes (NOT activated: the test does that) → build and start notes →
 *   Playwright → stop everything. `--down` also removes the dev volumes (CI).
 *
 * First time on a machine: `pnpm --filter @asafarim/notes exec playwright install chromium`.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { bootstrap, readEnvFile } from "./bootstrap.mjs";
import { installDevApps } from "./apps.mjs";
import { bold, buildWorkspaceDependencies, compose, dbEnv, green, red, requireDocker, waitFor } from "./infra.mjs";
import { DEV, DEV_DIR, ISSUER, ROOT, ensureDevKeys } from "./keys.mjs";

const NOTES_DIR = path.join(ROOT, "apps/notes");
const NOTES_URL = `http://localhost:${DEV.apps.notes}`;
const children = [];

function start(name, args, cwd = ROOT) {
  const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

const service = (name, envFile, entry) =>
  start(name, [`--env-file=${path.join(DEV_DIR, envFile)}`, path.join(ROOT, entry)]);

let exitCode = 1;
try {
  requireDocker();
  ensureDevKeys();
  buildWorkspaceDependencies();
  compose("up", "-d", "--wait");
  await bootstrap(dbEnv());

  service("identity", "identity.env", "core/identity/src/server.ts");
  service("core-api", "core-api.env", "core/core-api/src/server.ts");
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

  const core = readEnvFile(path.join(DEV_DIR, "core-api.env"));
  const run = spawnSync("pnpm", ["--filter", "@asafarim/notes", "e2e"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      E2E_BASE_URL: NOTES_URL,
      E2E_CORE_API_URL: core.CORE_API_URL,
      E2E_ADMIN_TOKEN: core.CORE_API_ADMIN_TOKEN,
    },
  });
  exitCode = run.status ?? 1;
  console.log(exitCode === 0 ? green(bold("\ne2e: OK")) : red(bold("\ne2e: FAILED")));
} catch (err) {
  console.error(red(`\ne2e setup FAILED: ${err.message}`));
} finally {
  for (const c of children) c.kill();
  if (process.argv.includes("--down")) compose("down", "--volumes", "--remove-orphans");
}
process.exit(exitCode);
