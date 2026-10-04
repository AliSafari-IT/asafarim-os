#!/usr/bin/env node
/**
 * `pnpm dev` (OS-D1, #26): the whole OS locally, in one command.
 *   1. checks Docker;
 *   2. creates throwaway dev keys if missing (.dev/, git-ignored) and builds the
 *      workspace packages the services import (a fresh clone has no dist/);
 *   3. starts Postgres, Redis and the dev gateway (compose.dev.yml, 127.0.0.1 only);
 *   4. bootstraps the per-service databases and roles, migrates, seeds;
 *   5. runs core/identity, core-api and the dev login stub in watch mode;
 *   6. installs (and activates) every apps/* into core-api, then runs them in
 *      watch mode, so each one self-registers on boot.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap.mjs";
import { installDevApps } from "./apps.mjs";
import {
  bold,
  buildWorkspaceDependencies,
  checkGatewayEnv,
  compose,
  dbEnv,
  dim,
  green,
  requireDocker,
  waitFor,
} from "./infra.mjs";
import { DEV, ISSUER, ROOT, ensureDevKeys } from "./keys.mjs";

requireDocker();
ensureDevKeys();
buildWorkspaceDependencies();
checkGatewayEnv();
console.log(bold("Starting Postgres, Redis and the gateway…"));
compose("up", "-d", "--wait");
await bootstrap(dbEnv());

const { users } = JSON.parse(readFileSync(path.join(ROOT, "tools/dev-hub/seed-users.json"), "utf8"));
console.log(`
${green(bold("ASafariM OS dev environment"))}
  identity (OIDC)   ${ISSUER}/.well-known/openid-configuration
  core-api          http://localhost:${DEV.coreApiPort}/readyz   ${dim("(pnpm platform app install <id>)")}
  dev login stub    http://localhost:${DEV.devHubPort}   ${dim("(DEV ONLY: stands in for Hub)")}
  Postgres          127.0.0.1:${DEV.postgres.port}   Redis 127.0.0.1:56380
  apps              ${
    Object.entries(DEV.apps)
      .map(([id, port]) => `${id} http://localhost:${port}`)
      .join(", ") || "none yet"
  }
  gateway           ${Object.keys(DEV.apps)
    .map((id) => `http://${id}.localhost:${DEV.gatewayPort}`)
    .join(", ")}   ${dim("(the front door: lifecycle, 404s and permissions are enforced here)")}
  dev OIDC client   client_id=dev-app, redirect ${DEV.devClientCallback}, PKCE S256
  seeded users      ${users.map((u) => `${u.id}${u.isActive ? "" : " (inactive)"}`).join(", ")}
  ${dim("Stop with Ctrl+C. Reset everything: pnpm dev:reset")}
`);

const turbo = (filters) =>
  spawn("pnpm", ["exec", "turbo", "run", "dev", ...filters.map((f) => `--filter=${f}`)], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

const services = turbo(["@asafarim/identity", "@asafarim/core-api", "@asafarim/dev-hub"]);
const running = [services];
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => running.forEach((c) => c.kill(sig)));
services.on("exit", (code) => process.exit(code ?? 0));

// Apps need core-api to install into, and their credential file before they start.
// If anything here fails, stop the services too: a watch process left running
// would hold the ports and block the next `pnpm dev`.
try {
  await waitFor(`http://localhost:${DEV.coreApiPort}/readyz`);
  await installDevApps();
  running.push(turbo(["./apps/*"]));
} catch (err) {
  console.error(`\n${err.message}`);
  running.forEach((c) => c.kill());
  process.exit(1);
}
