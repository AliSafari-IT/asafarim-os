/**
 * What running an image-installed external app takes, shared by `pnpm dev:app` (scripts/dev/dev-app.mjs)
 * and `platform app compose` (src/compose.ts), so the two cannot drift apart: which image a worker runs,
 * and how every container of such an app is hardened.
 *
 * Plain JavaScript with a hand-written .d.mts, because the dev script runs on bare node and the CLI is
 * TypeScript.
 */

/** Every container of an external app: a read-only root with a small tmpfs /tmp, and nothing it doesn't need. */
export const HARDENING = {
  tmpfs: "/tmp:rw,noexec,nosuid,size=64m",
  capDrop: "ALL",
  securityOpt: "no-new-privileges:true",
};

/**
 * The image a worker runs. The manifest names images by short name (`igs-pharma-worker`), while what
 * was installed is a full reference (`ghcr.io/alisafari-it/igs-pharma-web:<sha>`):
 *   - the worker's image is the web image's name → the installed reference itself;
 *   - the installed reference ends in the web image's name → the same registry path and tag, with the
 *     worker's name (and the worker's own tag, when it gives one);
 *   - otherwise the worker's image as the manifest gives it.
 */
export function workerImage(webRef, manifest, worker) {
  const webName = manifest.runtime.image.split(":")[0];
  const [workerName, workerTag] = worker.image.split(":");
  if (worker.image === manifest.runtime.image || (workerName === webName && !workerTag)) return webRef;
  if (webRef.includes("@")) return worker.image; // a digest names one image; it can't be re-used for another
  const m = /^(?<prefix>(?:[^/]+\/)*)(?<name>[^/:]+)(?::(?<tag>[^/]+))?$/.exec(webRef);
  if (!m || m.groups.name !== webName.split("/").at(-1)) return worker.image;
  const tag = workerTag ?? m.groups.tag;
  return `${m.groups.prefix}${workerName.split("/").at(-1)}${tag ? `:${tag}` : ""}`;
}
