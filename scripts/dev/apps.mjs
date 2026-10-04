/**
 * Install the apps under apps/* into the running local core-api (P3.2): each
 * `apps/<id>/platform.app.ts` is compiled, installed (its own database and a
 * registry credential, written to `.dev/<id>.env`) and, for convenience in
 * development, activated. Safe to repeat: an app that's already installed is
 * left alone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEnvFile } from "./bootstrap.mjs";
import { DEV_DIR, ROOT } from "./keys.mjs";

/** True when two JSON texts hold the same value, whatever their formatting. */
export function sameJson(a, b) {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

export function appIds() {
  const dir = path.join(ROOT, "apps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "platform.app.ts")))
    .map((d) => d.name);
}

/** `pnpm platform …` from the repo root; returns { ok, output }. */
export function platform(args) {
  const r = spawnSync("pnpm", ["--silent", "platform", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function coreApiAdmin() {
  const env = readEnvFile(path.join(DEV_DIR, "core-api.env"));
  return { baseUrl: env.CORE_API_URL, token: env.CORE_API_ADMIN_TOKEN };
}

async function isInstalled(id) {
  const { baseUrl, token } = coreApiAdmin();
  const res = await fetch(`${baseUrl}/admin/v1/apps/${id}`, { headers: { authorization: `Bearer ${token}` } });
  return res.status === 200;
}

export async function installDevApps({ activate = true, log = console.log } = {}) {
  for (const id of appIds()) {
    const envFile = path.join(DEV_DIR, `${id}.env`);
    // Compile the manifest, but leave the committed platform.app.json alone when
    // nothing changed: the compiler's formatting differs from Prettier's, and a
    // dev run must not dirty the working tree.
    const jsonFile = path.join(ROOT, "apps", id, "platform.app.json");
    const before = existsSync(jsonFile) ? readFileSync(jsonFile, "utf8") : undefined;
    const compiled = platform(["manifest", "compile", `apps/${id}/platform.app.ts`]);
    if (!compiled.ok) throw new Error(`compiling apps/${id}/platform.app.ts failed:\n${compiled.output}`);
    if (before !== undefined && sameJson(before, readFileSync(jsonFile, "utf8"))) writeFileSync(jsonFile, before);

    const installed = await isInstalled(id);
    if (installed && existsSync(envFile)) {
      log(`app ${id}: already installed`);
      continue;
    }
    if (installed) {
      throw new Error(
        `${id} is installed in core-api but .dev/${id}.env (its credential) is missing. Run pnpm dev:reset, then pnpm dev.`,
      );
    }
    if (existsSync(envFile)) rmSync(envFile); // a stale credential from a reset database

    const out = platform(["app", "install", id, "--env-out", path.join(".dev", `${id}.env`)]);
    if (!out.ok) throw new Error(`installing ${id} failed:\n${out.output}`);
    log(`app ${id}: installed (${out.output.split("\n")[0]})`);
    if (activate) {
      const act = platform(["app", "activate", id]);
      if (!act.ok) throw new Error(`activating ${id} failed:\n${act.output}`);
      log(`app ${id}: ${act.output}`);
    }
  }
}
