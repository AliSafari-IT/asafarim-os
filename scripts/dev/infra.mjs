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

/** The core services `pnpm dev` starts; each imports workspace packages, so each needs them built. */
export const DEV_SERVICES = ["@asafarim/identity", "@asafarim/core-api", "@asafarim/dev-hub"];

/** The glob that covers every app package: `./apps/*^...` = their dependencies, not themselves. */
export const APPS_FILTER = "--filter=./apps/*^...";

/** The apps under <root>/apps: the directories that are packages (have a package.json). */
export function appPackages(root = ROOT) {
  let entries;
  try {
    entries = readdirSync(path.join(root, "apps"), { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((d) => d.isDirectory() && existsSync(path.join(root, "apps", d.name, "package.json")))
    .map((d) => d.name)
    .sort();
}

/** The turbo `--filter` arguments that build everything the dev services and the apps import. */
export function workspaceBuildFilters(root = ROOT) {
  const filters = DEV_SERVICES.map((s) => `--filter=${s}^...`);
  if (appPackages(root).length > 0) filters.push(APPS_FILTER);
  return filters;
}

/**
 * The apps (and services) whose dependencies none of `filters` builds. Empty
 * means covered. This is the guard against the "works locally, broken on a
 * clean checkout" incidents (#31, #33): a new app must not be missing from the
 * dependency build.
 */
export function uncoveredByFilters(filters, root = ROOT) {
  const covered = (id) => filters.includes(`--filter=${id}^...`);
  const missing = DEV_SERVICES.filter((s) => !covered(s));
  const appsCovered = filters.includes(APPS_FILTER);
  return [...missing, ...(appsCovered ? [] : appPackages(root).map((a) => `apps/${a}`))];
}

/**
 * Build the workspace packages the dev services import (@asafarim/app-manifest
 * and friends export their built dist/). A fresh clone has no dist/, so `pnpm
 * dev` and `pnpm dev:smoke` run this first; turbo caches it, so repeat runs
 * cost almost nothing. `<project>^...` = that project's dependencies, not itself.
 */
export function buildWorkspaceDependencies() {
  const filters = workspaceBuildFilters();
  const missing = uncoveredByFilters(filters);
  if (missing.length > 0) throw new Error(`the dependency build doesn't cover: ${missing.join(", ")}`);
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
      // Each request is bounded too: a service that accepts the connection but never answers
      // would otherwise outlast the tries × 500 ms window.
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (ok(r)) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}
