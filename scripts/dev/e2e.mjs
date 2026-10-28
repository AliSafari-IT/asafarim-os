#!/usr/bin/env node
/**
 * `pnpm e2e` (P3.2, P3.3a): the notes acceptance flows in a real browser.
 *   compose up (Postgres, Redis, the dev gateway) → bootstrap → identity + core-api (with a short
 *   access-token lifetime, so the revocation bound is tested for real) + dev login stub →
 *   install notes (NOT activated: the tests do that) → build and start notes →
 *   the external-app fixture: its image built with the manifest label, then `pnpm dev:app`'s code
 *   (#104): installed with `platform app install --image` (its database, its declared secret checked),
 *   its web container and worker run, activated (#87; the Status spec checks it's up) →
 *   the Admin console (build and start) →
 *   Docs (build and start), reading the made-up fixtures in apps/docs/fixtures (#80) →
 *   Playwright: notes.spec.ts (direct) and gateway.spec.ts (through http://notes.localhost:8080) in
 *   apps/notes, then admin.spec.ts (the console at http://core.localhost:8080, P3.3b) in core/admin,
 *   then docs.spec.ts (the reader, with Lighthouse) and notes.spec.ts (study notes, #81) in apps/docs →
 *   restart Docs, then the `@after-restart` test: the notes are still in its database →
 *   Flow (build and start; ADR 0001), then Docs restarted against local GitHub and Claude mocks
 *   (apps/flow/e2e/mocks.mjs): flow.spec.ts, slice 1 end to end through the bus (a #issue note, its
 *   draft, the approval, the issue), and the builder; slice2.spec.ts, slice 2's workflows against the
 *   mocks of GitHub, an email server and a webhook receiver, reached through FLOW_E2E_EGRESS →
 *   stop everything. `--down` also removes the dev volumes (CI).
 *   `--screenshots` (`pnpm screenshots`): the same stack, then only core/site's screenshot spec, which
 *   writes the asafarim.site screenshots to core/site/public/screenshots/ (#70).
 *
 * First time on a machine: `pnpm --filter @asafarim/notes exec playwright install chromium`.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { bootstrap, readEnvFile } from "./bootstrap.mjs";
import { installDevApps } from "./apps.mjs";
import { buildExternalApp, externalUpstreamEnv, runExternalApp, stopExternalApp } from "./external-app.mjs";
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
import { AI_MOCK_URL, GITHUB_MOCK_URL, GITHUB_TLS_PORT, RECEIVER_PORT, SMTP_PORT } from "../../apps/flow/e2e/mocks.mjs";
import { makeE2eCert } from "./e2e-tls.mjs";

const NOTES_DIR = path.join(ROOT, "apps/notes");
const DOCS_DIR = path.join(ROOT, "apps/docs");
const DOCS_URL = `http://localhost:${DEV.apps.docs}`;
const FLOW_DIR = path.join(ROOT, "apps/flow");
const FLOW_URL = `http://localhost:${DEV.apps.flow}`;
const ADMIN_DIR = path.join(ROOT, "core/admin");
const ADMIN_URL = `http://localhost:${DEV.adminPort}`;
const ADMIN_GATEWAY_URL = `http://core.localhost:${DEV.gatewayPort}`;
const NOTES_URL = `http://localhost:${DEV.apps.notes}`;
const GATEWAY_URL = `http://notes.localhost:${DEV.gatewayPort}`;
// Access tokens live this long in the e2e (production: 60 s); the gateway spec asserts against it.
const TOKEN_TTL = Number(process.env.E2E_TOKEN_TTL ?? 6);
// `pnpm screenshots` (#70): the same stack, then core/site's screenshot spec instead of the e2e suites.
const SCREENSHOTS = process.argv.includes("--screenshots");
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
  buildExternalApp();

  service("identity", "identity.env", "core/identity/src/server.ts");
  service("core-api", "core-api.env", "core/core-api/src/server.ts", {
    ...process.env,
    CORE_API_ACCESS_TOKEN_TTL_SECONDS: String(TOKEN_TTL),
    ...externalUpstreamEnv(),
  });
  service("dev-hub", "dev-hub.env", "tools/dev-hub/src/server.ts");
  await waitFor(`${ISSUER}/readyz`);
  await waitFor(`http://localhost:${DEV.coreApiPort}/readyz`);
  await waitFor(`http://localhost:${DEV.devHubPort}/healthz`);
  console.log(`${green("✔")} identity, core-api and the dev login stub are ready`);

  await installDevApps({ activate: false });
  await runExternalApp();

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

  // Docs (#80): a production build reading the fixtures from disk (no GitHub token in the e2e).
  console.log(bold("Building Docs…"));
  const docsNext = path.join(DOCS_DIR, "node_modules/next/dist/bin/next");
  const docsBuild = spawnSync(process.execPath, [docsNext, "build"], { cwd: DOCS_DIR, stdio: "inherit" });
  if (docsBuild.status !== 0) throw new Error("next build (docs) failed");
  const startDocs = async (extraEnv = {}) => {
    const child = start("docs", [docsNext, "start", "--port", String(DEV.apps.docs)], DOCS_DIR, {
      ...process.env,
      DOCS_SOURCE_DIR: path.join(DOCS_DIR, "fixtures"),
      ...extraEnv,
    });
    await waitFor(`${DOCS_URL}/api/health`);
    return child;
  };
  let docs = await startDocs();
  console.log(`${green("✔")} Docs is up at ${DOCS_URL}, reading the fixtures`);

  // Flow (ADR 0001): it consumes Docs' events from the bus, so it runs next to Docs.
  const e2eTls = makeE2eCert(path.join(DEV_DIR, "e2e-tls"));
  if (!SCREENSHOTS) {
    console.log(bold("Building Flow…"));
    const flowNext = path.join(FLOW_DIR, "node_modules/next/dist/bin/next");
    const flowBuild = spawnSync(process.execPath, [flowNext, "build"], { cwd: FLOW_DIR, stdio: "inherit" });
    if (flowBuild.status !== 0) throw new Error("next build (flow) failed");
    // A credentials key of its own (none in .dev/): the specs add credentials and hook secrets. And the
    // e2e's routes (apps/flow/lib/egress/e2e.ts): GitHub, the email server and the webhook receiver are
    // the local mocks (apps/flow/e2e/mocks.mjs), behind a certificate made for this run only.
    const flow = start("flow", [flowNext, "start", "--port", String(DEV.apps.flow)], FLOW_DIR, {
      ...process.env,
      FLOW_CREDENTIALS_KEY: process.env.FLOW_CREDENTIALS_KEY ?? randomBytes(32).toString("base64"),
      FLOW_E2E_EGRESS: [
        `api.github.com:443=${GITHUB_TLS_PORT}`,
        `hooks.e2e.test:443=${RECEIVER_PORT}`,
        `smtp.e2e.test:465=${SMTP_PORT}`,
      ].join(","),
      FLOW_E2E_EGRESS_CA: e2eTls.cert,
    });
    // Flow's own answer, not another process that holds the port.
    const live = await (await waitFor(`${FLOW_URL}/health/live`)).json();
    if (flow.exitCode !== null || flow.signalCode !== null || live.app !== "flow")
      throw new Error(`Flow didn't start on ${FLOW_URL}`);
    console.log(`${green("✔")} Flow is up at ${FLOW_URL}`);
  }

  const core = readEnvFile(path.join(DEV_DIR, "core-api.env"));
  const e2eEnv = {
    ...process.env,
    E2E_BASE_URL: NOTES_URL,
    E2E_GATEWAY_URL: GATEWAY_URL,
    E2E_ADMIN_URL: ADMIN_GATEWAY_URL,
    E2E_DOCS_URL: DOCS_URL,
    E2E_FLOW_URL: FLOW_URL,
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
  // Every suite always runs (they share the stack, one after the other); the exit code is the first failure.
  // `--screenshots` (`pnpm screenshots`, #70) runs the site's screenshot spec on the same stack instead.
  const runs = SCREENSHOTS
    ? [["@asafarim/site", "screenshots"]]
    : [
        ["@asafarim/notes", "e2e"],
        ["@asafarim/admin", "e2e"],
        ["@asafarim/docs", "e2e", "--grep-invert", "@after-restart"],
      ];
  const run = ([pkg, script, ...args], env = e2eEnv) =>
    spawnSync("pnpm", ["--filter", pkg, script, ...args], {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    }).status ?? 1;
  const results = runs.map((r) => run(r));
  if (!SCREENSHOTS) {
    const stopDocs = async () => {
      if (docs.exitCode !== null) return;
      await new Promise((resolve) => {
        docs.once("exit", resolve);
        docs.kill();
      });
    };
    // Study notes survive a restart (#81): stop Docs, start it again, and look for them.
    console.log(bold("Restarting Docs…"));
    await stopDocs();
    docs = await startDocs();
    // Its own output and report folders: Playwright empties the ones it writes to, and the first
    // run's screenshots, Lighthouse scores and report must stay.
    results.push(
      run(["@asafarim/docs", "e2e", "--grep", "@after-restart", "--output", "test-results/after-restart"], {
        ...e2eEnv,
        PLAYWRIGHT_HTML_OUTPUT_DIR: "playwright-report/after-restart",
      }),
    );
    // Last: it writes notes in Docs, which the Docs suites don't expect. Docs drafts and creates
    // issues there, against local mocks of GitHub and Claude (never the real ones; fake credentials).
    start("mocks", [path.join(FLOW_DIR, "e2e/mocks.mjs")], ROOT, {
      ...process.env,
      E2E_TLS_KEY: e2eTls.key,
      E2E_TLS_CERT: e2eTls.cert,
    });
    await waitFor(`${GITHUB_MOCK_URL}/user`);
    console.log(bold("Restarting Docs against the GitHub and Claude mocks…"));
    await stopDocs();
    docs = await startDocs({
      DOCS_ISSUES_TOKEN: "e2e-not-a-token",
      DOCS_AI_API_KEY: "e2e-not-a-key",
      DOCS_E2E_GITHUB_API_URL: GITHUB_MOCK_URL,
      DOCS_E2E_AI_API_URL: AI_MOCK_URL,
    });
    results.push(run(["@asafarim/flow", "e2e"], { ...e2eEnv, E2E_GITHUB_MOCK_URL: GITHUB_MOCK_URL }));
  }
  exitCode = results.find((code) => code !== 0) ?? 0;
  const label = SCREENSHOTS ? "screenshots" : "e2e";
  console.log(exitCode === 0 ? green(bold(`\n${label}: OK`)) : red(bold(`\n${label}: FAILED`)));
} catch (err) {
  console.error(red(`\ne2e setup FAILED: ${err.message}`));
} finally {
  for (const c of children) c.kill();
  stopExternalApp();
  if (process.argv.includes("--down")) compose("down", "--volumes", "--remove-orphans");
}
process.exit(exitCode);
