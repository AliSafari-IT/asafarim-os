#!/usr/bin/env node
/**
 * `pnpm dev:app` (#104, IGS-1): run an app from another repository inside the local OS, from its image.
 *
 *   pnpm dev:app <image-ref> [--secrets <file>] [--port <n>]
 *   pnpm dev:app <id> --down
 *
 * Needs a running `pnpm dev` (core-api and the dev Postgres). It:
 *   1. reads the app's manifest from the image's org.asafarim.app.manifest label (pulling the image
 *      when it isn't local; a private image just reports that `docker pull` failed);
 *   2. checks that every name in the manifest's `secrets` has a value in the secrets file (default
 *      .dev/apps/<id>.secrets.env, git-ignored); a missing one stops the run before anything is
 *      installed or started. Values are never printed;
 *   3. installs it with `platform app install --image <ref> --env-out .dev/apps/<id>.env` (mode 600),
 *      unless it is already installed: then the saved env file is reused;
 *   4. runs the web container and each `runtime.workers` entry, hardened (read-only root with a tmpfs
 *      /tmp, every capability dropped, no-new-privileges, the manifest's memory and CPU limits), on the
 *      dev compose network so DATABASE_URL reaches the dev Postgres; only the web port is published, on
 *      127.0.0.1;
 *   5. tells core-api where the app runs (OS_APP_<ID>_UPSTREAM in .dev/core-api.env; `pnpm dev`'s
 *      core-api runs in watch mode and restarts on that change), so the Status board polls its
 *      live/ready paths, and activates it, so it shows in the launcher.
 * `--down` removes the app's containers and keeps its install and data; `pnpm dev:reset` wipes everything.
 *
 * Every environment value goes to docker through its own environment (`-e NAME`), never on the command
 * line, and everything this script prints has those values masked.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appState, coreApiAdmin, platform } from "./apps.mjs";
import { readEnvFile } from "./bootstrap.mjs";
import { DEV, DEV_DIR, ROOT, upsertLines, upstreamVar } from "./keys.mjs";

export const MANIFEST_LABEL = "org.asafarim.app.manifest";
/** Containers this script starts carry this label (value: the app id), so `--down` finds them all. */
export const APP_LABEL = "org.asafarim.dev-app";
/** compose.dev.yml's network (project asafarim-os-dev): the app reaches the dev Postgres as `postgres`. */
export const DEV_NETWORK = "asafarim-os-dev_default";
const APP_ID = /^[a-z][a-z0-9-]{1,31}$/;
/** As tools/platform-cli/src/image.ts: `[registry[:port]/]name[:tag][@sha256:…]`, never starting with `-`. */
const IMAGE_REF =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+|\/)[a-z0-9]+)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
export const isImageRef = (ref) => typeof ref === "string" && ref.length <= 512 && IMAGE_REF.test(ref);

export const USAGE = [
  "Usage: pnpm dev:app <image-ref> [--secrets <file>] [--port <n>]",
  "       pnpm dev:app <id> --down",
];

export class DevAppError extends Error {}

/** The command line, or `{ error }`. */
export function parseArgs(argv) {
  const opts = { down: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--down") opts.down = true;
    else if (a === "--secrets" || a === "--port") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
      if (a === "--secrets") opts.secretsFile = v;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) return { error: "--port must be a port from 1024 to 65535" };
        opts.port = n;
      }
    } else if (a.startsWith("-")) return { error: `unknown option ${a}` };
    else rest.push(a);
  }
  if (rest.length !== 1) return { error: "give one image reference (or one app id with --down)" };
  if (opts.down) {
    if (!APP_ID.test(rest[0])) return { error: `"${rest[0]}" isn't an app id` };
    if (opts.secretsFile || opts.port) return { error: "--down takes no other option" };
    return { ...opts, id: rest[0] };
  }
  if (!isImageRef(rest[0])) return { error: `"${rest[0]}" isn't an image reference (registry/name:tag)` };
  return { ...opts, ref: rest[0] };
}

/** Replace every given value in `text` with `***` (longest first, so a value inside another is covered). */
export function redact(text, values) {
  let out = String(text);
  for (const v of [...new Set(values)]
    .filter((s) => typeof s === "string" && s.length >= 4)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(v).join("***");
  }
  return out;
}

const lastLine = (s) =>
  String(s ?? "")
    .trim()
    .split(/\r?\n/)
    .at(-1) ?? "";

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

/** DATABASE_URL as the container sees it: the dev Postgres is `postgres:5432` on the compose network. */
export function containerDatabaseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && Number(u.port) === DEV.postgres.port) {
    u.hostname = "postgres";
    u.port = "5432";
  }
  return u.toString();
}

function databasePassword(url) {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}

/** `docker run` arguments for one container. Environment NAMES only: the values come from docker's own env. */
export function runArgs({ id, name, image, envNames, resources, port, hostPort }) {
  return [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${APP_LABEL}=${id}`,
    "--network",
    DEV_NETWORK,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    ...(resources?.memory ? ["--memory", resources.memory] : []),
    ...(resources?.cpus ? ["--cpus", String(resources.cpus)] : []),
    ...envNames.flatMap((n) => ["-e", n]),
    ...(port ? ["-p", `127.0.0.1:${hostPort ?? port}:${port}`] : []),
    image,
  ];
}

/** The containers `pnpm dev:app` started for an app. */
function appContainers(id, docker) {
  const r = docker(["ps", "-aq", "--filter", `label=${APP_LABEL}=${id}`]);
  if (r.status !== 0) throw new DevAppError(`docker ps failed: ${lastLine(r.stderr)}`);
  return r.stdout.split(/\s+/).filter(Boolean);
}

function removeContainers(id, docker) {
  const ids = appContainers(id, docker);
  if (ids.length > 0) {
    const r = docker(["rm", "-f", ...ids]);
    if (r.status !== 0) throw new DevAppError(`docker rm failed: ${lastLine(r.stderr)}`);
  }
  return ids.length;
}

/** The manifest in the image's label; pulls the image first when it isn't local. */
function imageManifest(ref, docker, log) {
  const inspect = () => docker(["image", "inspect", "--format", "{{json .Config.Labels}}", ref]);
  let r = inspect();
  if (r.status !== 0) {
    log(`pulling ${ref}…`);
    const pull = docker(["pull", ref]);
    if (pull.status !== 0) {
      throw new DevAppError(
        `docker pull ${ref} failed: ${lastLine(pull.stderr) || `exit ${pull.status}`}. If the image is private, log in to its registry yourself first.`,
      );
    }
    r = inspect();
    if (r.status !== 0) throw new DevAppError(`can't inspect ${ref} after pulling it: ${lastLine(r.stderr)}`);
  }
  let label;
  try {
    label = JSON.parse(r.stdout)?.[MANIFEST_LABEL];
  } catch {
    throw new DevAppError("docker image inspect didn't answer with JSON");
  }
  if (label === undefined)
    throw new DevAppError(`${ref} has no ${MANIFEST_LABEL} label, so it doesn't say what app it is.`);
  let m;
  try {
    m = JSON.parse(label);
  } catch {
    throw new DevAppError(`${ref}: the ${MANIFEST_LABEL} label isn't JSON.`);
  }
  if (!APP_ID.test(m?.id ?? "") || !Number.isInteger(m?.runtime?.port) || typeof m?.runtime?.image !== "string") {
    throw new DevAppError(`${ref}: the manifest in its label has no usable id, runtime.image or runtime.port.`);
  }
  return m;
}

/** The real side effects; tests pass their own. */
export function realDeps() {
  return {
    devDir: DEV_DIR,
    root: ROOT,
    docker: (args, env) => {
      const r = spawnSync("docker", args, {
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.error) return { status: 127, stdout: "", stderr: `docker can't be run (${r.error.message})` };
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    platform,
    appState,
    coreApiReady: async () => {
      let baseUrl;
      try {
        ({ baseUrl } = coreApiAdmin());
      } catch {
        return false; // no .dev/core-api.env: `pnpm dev` never ran
      }
      try {
        return (await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(3000) })).status === 200;
      } catch {
        return false;
      }
    },
    setUpstream: (id, hostPort) =>
      upsertLines(path.join(DEV_DIR, "core-api.env"), [`${upstreamVar(id)}=localhost:${hostPort}`]),
    log: console.log,
  };
}

/** `pnpm dev:app <id> --down`: remove the app's containers; the install and its data stay. */
export function devAppDown(id, deps = realDeps()) {
  const n = removeContainers(id, deps.docker);
  deps.log(
    `app ${id}: ${n === 0 ? "no containers running" : `${n} container(s) removed`}; its install and data are kept (pnpm dev:reset wipes everything)`,
  );
  return n;
}

/**
 * `pnpm dev:app <image-ref>`: install (once), run and activate an image-installed app.
 * Returns { id, port, containers }. Throws DevAppError with a message that is safe to print.
 */
export async function devApp({ ref, secretsFile, port: hostPortOpt }, deps = realDeps()) {
  const { docker, devDir, root } = deps;
  const known = []; // every value that must never be printed
  const log = (line) => deps.log(redact(line, known));
  const fail = (msg) => {
    throw new DevAppError(redact(msg, known));
  };

  if (!(await deps.coreApiReady())) {
    fail(`core-api isn't reachable at http://localhost:${DEV.coreApiPort}. Start the OS with \`pnpm dev\` first.`);
  }
  if (docker(["network", "inspect", DEV_NETWORK]).status !== 0) {
    fail(`the dev network ${DEV_NETWORK} doesn't exist. Start the OS with \`pnpm dev\` first.`);
  }

  const manifest = imageManifest(ref, docker, log);
  const { id } = manifest;
  const appsDir = path.join(devDir, "apps");
  const rel = (f) => path.relative(root, f).split(path.sep).join("/");

  // Secrets: every declared name needs a value, checked before anything is installed or started.
  const declared = manifest.secrets ?? [];
  const secretsPath = secretsFile ? path.resolve(root, secretsFile) : path.join(appsDir, `${id}.secrets.env`);
  if (secretsFile && !existsSync(secretsPath))
    fail(`--secrets ${secretsFile}: no such file. Nothing was installed or started.`);
  const given = existsSync(secretsPath) ? readEnvFile(secretsPath) : {};
  known.push(...Object.values(given));
  const missing = declared.filter((n) => !given[n]);
  if (missing.length > 0) {
    fail(
      [
        `${id} needs ${missing.length} secret(s) with no value in ${rel(secretsPath)}: ${missing.join(", ")}`,
        `Add a NAME=value line for each (the file is git-ignored), then run this again. Nothing was installed or started.`,
      ].join("\n"),
    );
  }

  // Install once; a re-run reuses the saved credential and DATABASE_URL.
  mkdirSync(appsDir, { recursive: true, mode: 0o700 });
  const envFile = path.join(appsDir, `${id}.env`);
  const state = await deps.appState(id);
  if (state === null) {
    rmSync(envFile, { force: true }); // a stale credential from a reset database
    const r = deps.platform(["app", "install", "--image", ref, "--env-out", rel(envFile)]);
    if (!r.ok) fail(`platform app install --image ${ref} failed:\n${r.output}`);
    log(`app ${id}: installed from ${ref}; credential and database URL in ${rel(envFile)}`);
  } else if (!existsSync(envFile)) {
    fail(
      `${id} is installed in core-api but ${rel(envFile)} (its credential) is missing. Run pnpm dev:reset, then pnpm dev.`,
    );
  } else {
    log(`app ${id}: already installed (${state}); reusing ${rel(envFile)}`);
  }
  chmodSync(envFile, 0o600);

  const installed = readEnvFile(envFile);
  // Everything but the app's id is secret; a database password is masked on its own too.
  known.push(...Object.entries(installed).flatMap(([k, v]) => (k === "ASAFARIM_APP_ID" ? [] : [v])));
  if (installed.DATABASE_URL) known.push(databasePassword(installed.DATABASE_URL));
  const env = {
    ...installed,
    ...Object.fromEntries(declared.map((n) => [n, given[n]])),
    // core-api on the host, as the container sees it (the app registers there with its credential).
    CORE_API_URL: `http://host.docker.internal:${DEV.coreApiPort}`,
  };
  if (installed.DATABASE_URL) env.DATABASE_URL = containerDatabaseUrl(installed.DATABASE_URL);
  known.push(env.DATABASE_URL);
  const envNames = Object.keys(env);

  // The containers: any left from an earlier run go first, so a re-run starts the current image.
  removeContainers(id, docker);
  const port = manifest.runtime.port;
  const hostPort = hostPortOpt ?? port;
  const containers = [
    {
      name: `asafarim-os-app-${id}`,
      image: ref,
      resources: manifest.runtime.resources,
      port,
      hostPort,
    },
    ...(manifest.runtime.workers ?? []).map((w) => ({
      name: `asafarim-os-app-${id}-${w.name}`,
      image: workerImage(ref, manifest, w),
      resources: w.resources,
    })),
  ];
  for (const c of containers) {
    const r = docker(runArgs({ id, envNames, ...c }), env);
    if (r.status !== 0) {
      removeContainers(id, docker);
      fail(`docker run ${c.name} (${c.image}) failed: ${lastLine(r.stderr) || `exit ${r.status}`}`);
    }
  }
  log(`app ${id}: running at http://localhost:${hostPort} (${containers.map((c) => c.name).join(", ")})`);

  // Where core-api polls its health (the Status board), then active: in the launcher and on the board.
  deps.setUpstream(id, hostPort);
  if (state !== "active") {
    const r = deps.platform(["app", "activate", id]);
    if (!r.ok) fail(`activating ${id} failed:\n${r.output}`);
  }
  log(
    `app ${id}: active. Status board: http://core.localhost:${DEV.gatewayPort}/admin/status; stop it with pnpm dev:app ${id} --down`,
  );
  return { id, port: hostPort, containers: containers.map((c) => c.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`${opts.error}\n${USAGE.join("\n")}`);
    process.exit(2);
  }
  try {
    if (opts.down) devAppDown(opts.id);
    else await devApp(opts);
  } catch (err) {
    console.error(err instanceof DevAppError ? err.message : `dev:app failed: ${err.message}`);
    process.exit(1);
  }
}
