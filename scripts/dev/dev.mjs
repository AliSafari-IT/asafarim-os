#!/usr/bin/env node
/**
 * `pnpm dev` (OS-D1, #26): the whole OS locally, in one command.
 *   1. checks Docker;
 *   2. creates throwaway dev keys if missing (.dev/, git-ignored) and builds the
 *      workspace packages the services import (a fresh clone has no dist/);
 *   3. starts Postgres and Redis (compose.dev.yml, 127.0.0.1 only);
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
import { bold, buildWorkspaceDependencies, compose, dbEnv, dim, green, requireDocker, waitFor } from "./infra.mjs";
import { DEV, ISSUER, ROOT, ensureDevKeys } from "./keys.mjs";

requireDocker();
ensureDevKeys();
buildWorkspaceDependencies();
console.log(bold("Starting Postgres and Redis…"));
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
await waitFor(`http://localhost:${DEV.coreApiPort}/readyz`);
await installDevApps();
running.push(turbo(["./apps/*"]));
