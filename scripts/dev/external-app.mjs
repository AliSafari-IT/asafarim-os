/**
 * The external-app fixture in `pnpm e2e` (#87): an app from "another repository", installed the way such
 * apps are, from its image. The image is built here with the manifest in its OCI label, then run through
 * `pnpm dev:app`'s own code (#104): installed with `platform app install --image` (never from apps/),
 * its database provisioned, its declared secret checked, its web container and worker started, and
 * activated, so the Admin Status board shows an app the OS only knows by its image.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { MANIFEST_LABEL, devApp, devAppDown } from "./dev-app.mjs";
import { DEV_DIR, ROOT, upstreamVar } from "./keys.mjs";

const DIR = path.join(ROOT, "tools/platform-cli/fixtures/external-app");
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, "platform.app.json"), "utf8"));

export const EXTERNAL_APP = { id: MANIFEST.id, image: "ext-demo:e2e", port: MANIFEST.runtime.port };

/** core-api polls the app's health here (as for the apps under apps/*, keys.mjs). */
export const externalUpstreamEnv = () => ({ [upstreamVar(EXTERNAL_APP.id)]: `localhost:${EXTERNAL_APP.port}` });

/** Build the image with its manifest label, and give each declared secret a throwaway value. */
export function buildExternalApp() {
  const manifest = readFileSync(path.join(DIR, "platform.app.json"), "utf8");
  const r = spawnSync(
    "docker",
    ["build", "-q", "--label", `${MANIFEST_LABEL}=${manifest}`, "-t", EXTERNAL_APP.image, DIR],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`docker build (ext-demo) failed: ${(r.stderr || r.stdout || "").trim()}`);
  const appsDir = path.join(DEV_DIR, "apps");
  mkdirSync(appsDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(appsDir, `${EXTERNAL_APP.id}.secrets.env`),
    `${(MANIFEST.secrets ?? []).map((n) => `${n}=e2e-${randomBytes(12).toString("base64url")}`).join("\n")}\n`,
    { mode: 0o600 },
  );
}

/** `pnpm dev:app ext-demo:e2e`, in process. Call once core-api is ready. */
export const runExternalApp = () => devApp({ ref: EXTERNAL_APP.image });

/** `pnpm dev:app ext-demo --down`, and forget the local record (external-apps/ext-demo), so `platform sync --check` stays clean. */
export function stopExternalApp() {
  try {
    devAppDown(EXTERNAL_APP.id);
  } catch (err) {
    console.error(err.message);
  }
  rmSync(path.join(ROOT, "external-apps", EXTERNAL_APP.id), { recursive: true, force: true });
}
