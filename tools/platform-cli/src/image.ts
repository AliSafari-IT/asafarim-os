/**
 * External apps (#87, OS ADR 0001 Addendum D): an app from another repository is installed from its
 * image. Its manifest travels in the image's OCI label `org.asafarim.app.manifest` (the full
 * platform.app.json), so the CLI reads it with `docker image inspect` (pulling first when the image
 * isn't local) and never starts a container to get it.
 *
 * Docker is reached through a `Docker` runner, so tests use a fake one and need no Docker.
 */
import { spawnSync } from "node:child_process";
import { formatProblems, validateManifest, type AppManifest } from "@asafarim/app-manifest";

export const MANIFEST_LABEL = "org.asafarim.app.manifest";

/**
 * An image reference: `[registry[:port]/]name[:tag][@sha256:digest]`, lower case. It never starts with
 * `-`, so it can't be read as a docker option.
 */
const IMAGE_REF =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+|\/)[a-z0-9]+)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

export const isImageRef = (ref: string) => ref.length <= 512 && IMAGE_REF.test(ref);

export interface DockerResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Docker = (args: string[]) => DockerResult;

/** The real docker CLI. */
export const docker: Docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: "", stderr: `docker can't be run (${r.error.message})` };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type ImageManifest = { ok: true; manifest: AppManifest; pulled: boolean } | { ok: false; lines: string[] };

const lastLine = (s: string) => s.trim().split(/\r?\n/).at(-1) ?? "";

/** The image's labels, or a reason it has none to give. */
function inspectLabels(ref: string, run: Docker): { labels: Record<string, string> | null } | { error: string } {
  const r = run(["image", "inspect", "--format", "{{json .Config.Labels}}", ref]);
  if (r.status !== 0) return { error: lastLine(r.stderr) || `docker image inspect exited with ${r.status}` };
  try {
    return { labels: JSON.parse(r.stdout) as Record<string, string> | null };
  } catch {
    return { error: "docker image inspect didn't answer with JSON" };
  }
}

/**
 * The validated manifest from the image's label. Pulls the image only when it isn't there locally.
 * A missing or invalid label stops here, with the validator's messages.
 */
export function readImageManifest(ref: string, run: Docker = docker): ImageManifest {
  if (!isImageRef(ref)) {
    return { ok: false, lines: [`"${ref}" isn't an image reference (registry/name:tag or name@sha256:…).`] };
  }
  let pulled = false;
  let inspected = inspectLabels(ref, run);
  if ("error" in inspected) {
    const pull = run(["pull", ref]);
    if (pull.status !== 0) {
      return {
        ok: false,
        lines: [`The image ${ref} isn't here and can't be pulled: ${lastLine(pull.stderr) || `exit ${pull.status}`}`],
      };
    }
    pulled = true;
    inspected = inspectLabels(ref, run);
    if ("error" in inspected)
      return { ok: false, lines: [`Can't inspect ${ref} after pulling it: ${inspected.error}`] };
  }

  const label = inspected.labels?.[MANIFEST_LABEL];
  if (label === undefined) {
    return {
      ok: false,
      lines: [
        `${ref} has no ${MANIFEST_LABEL} label, so it doesn't say what app it is.`,
        `Build it with --label "${MANIFEST_LABEL}=$(cat platform.app.json)".`,
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(label);
  } catch {
    return { ok: false, lines: [`${ref}: the ${MANIFEST_LABEL} label isn't JSON.`] };
  }
  const result = validateManifest(value);
  if (!result.ok) {
    return {
      ok: false,
      lines: [
        `✖ ${ref}: the manifest in its ${MANIFEST_LABEL} label has ${result.problems.length} problem(s)`,
        formatProblems(result.problems),
      ],
    };
  }
  return { ok: true, manifest: result.manifest, pulled };
}
