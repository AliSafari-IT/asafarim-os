/** Shared helpers for the dev scripts (OS-D1, #26): Docker, compose, env. */
import { spawnSync } from "node:child_process";
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

/** The bootstrap's passwords: db.env plus core-api's own database password. */
export const dbEnv = () => ({
  ...readEnvFile(path.join(DEV_DIR, "db.env")),
  ...readEnvFile(path.join(DEV_DIR, "core-api.env")),
});
