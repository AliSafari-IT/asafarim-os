/**
 * The external-app fixture in `pnpm e2e` (#87): an app from "another repository", installed the way such
 * apps are, from its image. The image is built here with the manifest in its OCI label, runs as a
 * container on the host, and is installed with `platform app install --image` (never from apps/), so the
 * Admin Status board shows an app the OS only knows by its image.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { appState, platform } from "./apps.mjs";
import { ROOT, upstreamVar } from "./keys.mjs";

export const EXTERNAL_APP = {
  id: "ext-demo",
  image: "ext-demo:e2e",
  container: "asafarim-os-e2e-ext-demo",
  port: 4120,
  dir: path.join(ROOT, "tools/platform-cli/fixtures/external-app"),
};
const LABEL = "org.asafarim.app.manifest";

function docker(args, what) {
  const r = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout;
}

/** core-api polls the app's health here (as for the apps under apps/*, keys.mjs). */
export const externalUpstreamEnv = () => ({ [upstreamVar(EXTERNAL_APP.id)]: `localhost:${EXTERNAL_APP.port}` });

/** Build the image with its manifest label and run it. Call before core-api starts polling. */
export function startExternalApp() {
  const { image, container, port, dir } = EXTERNAL_APP;
  const manifest = readFileSync(path.join(dir, "platform.app.json"), "utf8");
  docker(["build", "-q", "--label", `${LABEL}=${manifest}`, "-t", image, dir], "docker build (ext-demo)");
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  docker(
    [
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      `127.0.0.1:${port}:8080`,
      "--read-only",
      "--cap-drop",
      "ALL",
      image,
    ],
    "docker run (ext-demo)",
  );
}

/**
 * Install it from the image (its manifest from the label) and activate it. A run without `--down`
 * leaves it installed in the dev database: then it's only activated.
 */
export async function installExternalApp({ log = console.log } = {}) {
  const { id, image } = EXTERNAL_APP;
  const state = await appState(id);
  if (state === null) {
    const r = platform(["app", "install", "--image", image, "--env-out", `.dev/${id}.env`]);
    if (!r.ok) throw new Error(`platform app install --image ${image} failed:\n${r.output}`);
    log(`app ${id}: installed from ${image}`);
  }
  if (state !== "active") {
    const r = platform(["app", "activate", id]);
    if (!r.ok) throw new Error(`activating ${id} failed:\n${r.output}`);
  }
  log(`app ${id}: active`);
}

/** Stop the container and forget the local record (external-apps/ext-demo), so `platform sync --check` stays clean. */
export function stopExternalApp() {
  spawnSync("docker", ["rm", "-f", EXTERNAL_APP.container], { stdio: "ignore" });
  rmSync(path.join(ROOT, "external-apps", EXTERNAL_APP.id), { recursive: true, force: true });
}
