/** Shared helpers for the dev scripts (OS-D1, #26): Docker, compose, env. */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEV_DIR, ROOT } from "./keys.mjs";
import { readEnvFile } from "./bootstrap.mjs";

export const COMPOSE = ["compose", "-f", path.join(ROOT, "compose.dev.yml")];

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = color("1");
export const red = color("31");
export const green = color("32");
export const dim = color("2");

export function dockerAvailable() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

export function requireDocker() {
  if (dockerAvailable()) return;
  console.error(
    red("Docker isn't running.") + " Start Docker Desktop (or the Docker daemon) and run the command again.",
  );
  process.exit(1);
}

/** docker compose … for the dev stack; throws on failure. */
export function compose(...args) {
  const r = spawnSync("docker", [...COMPOSE, ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(" ")} failed`);
}

/**
 * Build the workspace packages the dev services import (@asafarim/app-manifest
 * and friends export their built dist/). A fresh clone has no dist/, so `pnpm
 * dev` and `pnpm dev:smoke` run this first; turbo caches it, so repeat runs
 * cost almost nothing. `<project>^...` = that project's dependencies, not itself.
 */
export function buildWorkspaceDependencies() {
  const services = ["@asafarim/identity", "@asafarim/core-api", "@asafarim/dev-hub"];
  // Every app under apps/* imports workspace packages too (@asafarim/app-sdk).
  const hasApps = existsSync(path.join(ROOT, "apps")) && readdirSync(path.join(ROOT, "apps")).length > 0;
  const filters = [...services.map((s) => `--filter=${s}^...`), ...(hasApps ? ["--filter=./apps/*^..."] : [])];
  const args = ["exec", "turbo", "run", "build", "--output-logs=errors-only", ...filters];
  console.log(bold("Building workspace dependencies (first run on a fresh clone only)…"));
  const r = spawnSync("pnpm", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error("building the workspace dependencies failed");
}

/** The bootstrap's passwords: db.env plus core-api's own database password. */
export const dbEnv = () => ({
  ...readEnvFile(path.join(DEV_DIR, "db.env")),
  ...readEnvFile(path.join(DEV_DIR, "core-api.env")),
});

/** Poll `url` until `ok(response)` (default: HTTP 200); throws after `tries` × 500 ms. */
export async function waitFor(url, ok = (r) => r.status === 200, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (ok(r)) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}
