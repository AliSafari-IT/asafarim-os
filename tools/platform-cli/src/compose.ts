/**
 * `platform app compose <id|image-ref> --env prod|staging --out <file>` (#106, IGS-2a): write the
 * docker compose file that runs an image-installed external app on a host: the web service, one
 * service per `runtime.workers[]` and, for an app with a database, a one-shot migrator.
 *
 * It only writes a file. It runs nothing, and no secret value ever goes in it or is printed: secrets are
 * `${NAME}` references the host's environment (or an env file) answers when compose runs. The same
 * hardening as `pnpm dev:app` applies to every container (src/external-runtime.mjs).
 *
 * Process scopes: the web service and each worker get `DATABASE_URL` (the app's runtime role) and the
 * manifest's secrets; the migrator gets only its own DSN, on its own variable, so a migration
 * credential never reaches a process that serves requests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { formatProblems, validateManifest, type AppManifest } from "@asafarim/app-manifest";
import { HARDENING, workerImage } from "./external-runtime.mjs";
import { docker, isImageRef, readImageManifest, type Docker } from "./image.ts";
import { loadManifestFile } from "./manifest.ts";
import { EXTERNAL_APPS_DIR, EXTERNAL_SOURCE_FILE, MANIFEST_FILE, gatewayUpstreamVar } from "./sync.ts";

export type ComposeEnv = "prod" | "staging";

export interface ComposeOptions {
  env: ComposeEnv;
  /** The reference the web service runs (the one the app was installed from). */
  image: string;
  /** Worker name → image reference, for a worker the web image's reference can't derive. */
  workerImages?: Record<string, string>;
  /** Secret name → the processes that get it (`web`, a worker's name); a secret without an entry goes to all of them. */
  scopes?: Record<string, string[]>;
  /** The migrator's command (it replaces the image's entrypoint); defaults per `database.migrations`. */
  migrateCommand?: string[];
}

export interface ComposeFile {
  /** The compose project the file is meant to run as. */
  project: string;
  /** What `OS_APP_<ID>_UPSTREAM` is to be set to for the gateway. */
  upstream: { variable: string; value: string };
  /** The environment variables `docker compose up` requires, with who gets each (names only). */
  variables: { name: string; for: string[] }[];
  /**
   * The migrator's DSN variable, when there is a migrator. It is not required by `up`: it is supplied inline
   * for the one `--profile migrate run` command, so the migration credential never sits with the runtime ones.
   */
  migratorVariable?: string;
  /** The file's content. */
  yaml: string;
}

export type ComposeResult = { ok: true; file: ComposeFile } | { ok: false; lines: string[] };

/** The command a migration tool is run with; `sql` migrations have no standard one, so the caller says. */
export const MIGRATE_COMMANDS: Record<string, string[] | undefined> = {
  drizzle: ["drizzle-kit", "migrate"],
  prisma: ["prisma", "migrate", "deploy"],
};

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** A digest, or a tag that is a full commit sha: something that names one build. `latest` and friends are not. */
export function isPinnedImage(ref: string): boolean {
  if (DIGEST.test(ref)) return true;
  const tag = /^(?:[^@]*\/)?[^/@:]+:([^/@]+)$/.exec(ref)?.[1];
  return tag !== undefined && FULL_SHA.test(tag);
}

const variableName = (id: string, suffix: string) => `${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
const ref = (name: string) => `\${${name}:?set ${name}}`;
/**
 * Compose interpolates every service in the file, including ones in an inactive profile, so a required (`:?`)
 * reference on the migrator would make `up` demand the migration credential. This one is optional; an empty
 * value is the migration tool's to refuse.
 */
const optionalRef = (name: string) => `\${${name}:-}`;

/** Build the compose file, or say everything that stops it. Pure: nothing is read or written here. */
export function buildCompose(manifest: AppManifest, options: ComposeOptions): ComposeResult {
  const { id } = manifest;
  const { env } = options;
  const problems: string[] = [];
  const workers = manifest.runtime.workers ?? [];
  const processes = ["web", ...workers.map((w) => w.name)];
  if (new Set(processes).size !== processes.length || workers.some((w) => ["web", "migrate"].includes(w.name))) {
    problems.push(`a worker may not be called "web" or "migrate" (those are the other services of the file).`);
  }

  // Images: every one pinned, in prod and staging alike.
  const images = new Map<string, string>([["web", options.image]]);
  for (const w of workers) {
    images.set(w.name, options.workerImages?.[w.name] ?? workerImage(options.image, manifest, w));
  }
  for (const name of Object.keys(options.workerImages ?? {})) {
    if (!workers.some((w) => w.name === name))
      problems.push(`--worker-image ${name}=…: ${id} has no worker "${name}".`);
  }
  for (const [name, image] of images) {
    if (!isImageRef(image)) {
      problems.push(`${name}: "${image}" isn't an image reference.`);
    } else if (!isPinnedImage(image)) {
      const hint =
        name === "web"
          ? "install it from a digest or a full-commit-sha tag"
          : `give it with --worker-image ${name}=<name@sha256:… or name:<40-hex sha>>`;
      problems.push(
        `${name}: image "${image}" isn't pinned (${env} needs a digest or a full commit sha tag, not a floating tag): ${hint}.`,
      );
    }
  }

  // Secrets and their scopes.
  const declared = manifest.secrets ?? [];
  const scopes = options.scopes ?? {};
  for (const [name, who] of Object.entries(scopes)) {
    if (!declared.includes(name)) problems.push(`--scope ${name}: ${id} doesn't declare a secret called ${name}.`);
    for (const p of who)
      if (!processes.includes(p))
        problems.push(`--scope ${name}=${p}: ${id} has no process "${p}" (${processes.join(", ")}).`);
  }
  // The database and its migrator.
  const postgres = manifest.database.engine === "postgres" ? manifest.database : undefined;
  const dsn = variableName(id, "DATABASE_URL");
  const migratorDsn = variableName(id, "MIGRATOR_DATABASE_URL");
  // A declared secret may not take the name of a variable this file generates: it would go to the web
  // service and the workers by default, and the migrator's DSN must never reach them.
  const reserved = new Set(postgres ? ["DATABASE_URL", dsn, migratorDsn] : []);
  for (const name of declared) {
    if (reserved.has(name))
      problems.push(`the secret ${name} would clash with a database variable of the generated file.`);
  }
  let migrateCommand: string[] | undefined;
  if (postgres) {
    migrateCommand = options.migrateCommand ?? MIGRATE_COMMANDS[postgres.migrations];
    if (!migrateCommand) {
      problems.push(
        `the migrations are "${postgres.migrations}", which has no standard command: give the migrator's with --migrate-command '["…"]'.`,
      );
    }
  }
  if (problems.length > 0)
    return { ok: false, lines: [`✖ ${id}: can't write the compose file`, ...problems.map((p) => `  - ${p}`)] };

  const slug = `os-app-${id}${env === "staging" ? "-staging" : ""}`;
  const dbNetwork = `${id.replace(/-/g, "_")}${env === "staging" ? "_staging" : ""}_db`;
  const secretsFor = (process: string) => declared.filter((n) => (scopes[n] ?? processes).includes(process));
  const variables = new Map<string, string[]>();
  const need = (name: string, who: string) => variables.set(name, [...(variables.get(name) ?? []), who]);

  const hardened = (resources: { memory: string; cpus: number }) => ({
    restart: "unless-stopped",
    read_only: true,
    tmpfs: [HARDENING.tmpfs],
    security_opt: [HARDENING.securityOpt],
    cap_drop: [HARDENING.capDrop],
    mem_limit: resources.memory,
    cpus: resources.cpus,
  });
  const environment = (process: string) => {
    const out: Record<string, string> = {};
    if (postgres) {
      out.DATABASE_URL = ref(dsn);
      need(dsn, process);
    }
    for (const name of secretsFor(process)) {
      out[name] = ref(name);
      need(name, process);
    }
    return out;
  };
  const withEnvironment = (process: string) => {
    const e = environment(process);
    return Object.keys(e).length > 0 ? { environment: e } : {};
  };

  const services: Record<string, unknown> = {
    web: {
      image: images.get("web"),
      ...hardened(manifest.runtime.resources),
      // Reachable on the private networks and (for the edge) on its port only: nothing is published to the host.
      expose: [String(manifest.runtime.port)],
      ...withEnvironment("web"),
      networks: {
        app_net: {},
        ...(postgres ? { db_net: {} } : {}),
        edge_net: { aliases: [slug] },
      },
    },
  };
  for (const w of workers) {
    services[w.name] = {
      image: images.get(w.name),
      ...hardened(w.resources),
      ...withEnvironment(w.name),
      networks: {
        app_net: {},
        ...(postgres ? { db_net: {} } : {}),
        ...(w.network === "egress-only" ? { egress_net: {} } : {}),
      },
    };
  }
  if (postgres && migrateCommand) {
    services.migrate = {
      image: images.get("web"),
      profiles: ["migrate"],
      read_only: true,
      tmpfs: [HARDENING.tmpfs],
      security_opt: [HARDENING.securityOpt],
      cap_drop: [HARDENING.capDrop],
      mem_limit: manifest.runtime.resources.memory,
      cpus: manifest.runtime.resources.cpus,
      entrypoint: migrateCommand,
      environment: { DATABASE_URL: optionalRef(migratorDsn) },
      // The database only: no edge, no other service, no internet.
      networks: { db_net: {} },
    };
  }

  const needsEgress = workers.some((w) => w.network === "egress-only");
  const doc = {
    name: slug,
    services,
    networks: {
      // Between this app's own services; no way out.
      app_net: { internal: true },
      // The shared edge's network, created with the edge; only the web service joins it.
      edge_net: { external: true, name: "edge_net" },
      ...(postgres ? { db_net: { external: true, name: dbNetwork } } : {}),
      ...(needsEgress ? { egress_net: {} } : {}),
    },
  };

  const upstream = { variable: gatewayUpstreamVar(id), value: `${slug}:${manifest.runtime.port}` };
  const vars = [...variables].map(([name, who]) => ({ name, for: who }));
  const header = [
    `Generated by \`platform app compose ${id} --env ${env}\`: the ${env} stack of the external app ${id}. Edit the manifest or the options, not this file.`,
    `It holds no secret value: each \${NAME} below is answered by the environment (or an env file) when compose runs.`,
    `\`up\` needs ${vars.map((v) => v.name).join(", ") || "no variables"}${postgres ? `, and the external network ${dbNetwork} (the database's)` : ""}.`,
    ...(postgres
      ? [
          `${migratorDsn} is only for the migration, not for \`up\`: supply it inline for that one command, and keep it out of the runtime env file:`,
          `  ${migratorDsn}=… docker compose -p ${slug} -f <this file> --profile migrate run --rm migrate`,
        ]
      : []),
    `Then: docker compose -p ${slug} -f <this file> up -d`,
    `The gateway reaches the app at ${upstream.variable}=${upstream.value}.`,
  ];
  const yaml = `${header.map((l) => `# ${l}`).join("\n")}\n${stringify(doc, { lineWidth: 0 })}`;
  return {
    ok: true,
    file: { project: slug, upstream, variables: vars, ...(postgres ? { migratorVariable: migratorDsn } : {}), yaml },
  };
}

export const COMPOSE_HELP = [
  "Usage: platform app compose <id|image-ref> --env prod|staging --out <file> [options]",
  "",
  "Writes the docker compose file that runs an image-installed external app: the web service, one",
  "service per runtime.workers[] and, for an app with a database, a one-shot migrator (profile `migrate`).",
  "It runs nothing and writes no secret value: secrets are ${NAME} references answered when compose runs.",
  "",
  "  <id|image-ref>         an installed app (external-apps/<id>/), or an image to read the manifest from",
  "  --env prod|staging     both need pinned images: a sha256 digest or a full 40-hex commit sha tag",
  "  --out <file>           where to write the file",
  "  --manifest <file> --image <ref>",
  "                         use this platform.app.json and this image instead (no docker needed)",
  "  --worker-image <name>=<ref>",
  "                         a worker's image, when the web image's reference can't derive it (repeatable)",
  "  --scope <SECRET>=<process>[,<process>]",
  "                         only these processes (web, or a worker's name) get the secret (repeatable);",
  "                         without it a secret goes to the web service and every worker, never the migrator",
  "  --migrate-command '<json array>'",
  "                         the migrator's command, replacing the image's entrypoint. Defaults: drizzle →",
  '                         ["drizzle-kit","migrate"], prisma → ["prisma","migrate","deploy"]; `sql` has no default.',
  "                         The image must contain the tool (a production Next.js image often does not ship",
  "                         drizzle-kit); if it doesn't, pass the command its own migrate script needs.",
  "",
  "The migrator runs the web image with its own variable, <ID>_MIGRATOR_DATABASE_URL. `docker compose up`",
  "does not require it (compose reads every service, so it is optional in the file): supply it inline for the",
  "one `--profile migrate run --rm migrate` command, so the migration credential is not kept with the runtime",
  "ones. The web service and the workers get DATABASE_URL from <ID>_DATABASE_URL, which `up` does require.",
  "Only the web service joins the edge network (alias os-app-<id>[-staging]) and only its port is exposed;",
  "the command also prints the OS_APP_<ID>_UPSTREAM value.",
];

type Parsed =
  | { help: true }
  | {
      target?: string;
      env: ComposeEnv;
      out: string;
      manifestFile?: string;
      image?: string;
      workerImages: Record<string, string>;
      scopes: Record<string, string[]>;
      migrateCommand?: string[];
    }
  | { error: string };

export function parseComposeArgs(args: string[]): Parsed {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  let target: string | undefined;
  let env: string | undefined;
  let out: string | undefined;
  let manifestFile: string | undefined;
  let image: string | undefined;
  const workerImages: Record<string, string> = {};
  const scopes: Record<string, string[]> = {};
  let migrateCommand: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => {
      const v = args[++i];
      if (v === undefined || (v.startsWith("--") && a !== "--migrate-command")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--env") env = value();
      else if (a === "--out") out = value();
      else if (a === "--manifest") manifestFile = value();
      else if (a === "--image") image = value();
      else if (a === "--worker-image") {
        const [name, ...rest] = value().split("=");
        if (!name || rest.length === 0 || !rest.join("=")) throw new Error("--worker-image takes <name>=<ref>");
        workerImages[name] = rest.join("=");
      } else if (a === "--scope") {
        const [name, who] = value().split("=");
        if (!name || !who) throw new Error("--scope takes <SECRET>=<process>[,<process>]");
        scopes[name] = who.split(",").filter(Boolean);
      } else if (a === "--migrate-command") {
        const parsed: unknown = JSON.parse(value());
        if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((s) => typeof s === "string" && s)) {
          throw new Error("--migrate-command takes a JSON array of strings");
        }
        migrateCommand = parsed as string[];
      } else if (a.startsWith("-")) return { error: `unknown option ${a}` };
      else if (target === undefined) target = a;
      else return { error: `unexpected argument ${a}` };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
  if (env !== "prod" && env !== "staging") return { error: "--env must be prod or staging" };
  if (!out) return { error: "--out <file> is required" };
  if (manifestFile !== undefined || image !== undefined) {
    if (!manifestFile || !image || target !== undefined) {
      return { error: "--manifest and --image go together, and replace the <id|image-ref> argument" };
    }
  } else if (target === undefined) {
    return { error: "give an installed app's id or an image reference" };
  }
  return { target, env, out, manifestFile, image, workerImages, scopes, migrateCommand };
}

const APP_ID = /^[a-z][a-z0-9-]{1,31}$/;

/** The manifest and the image to run, from wherever the arguments point. */
async function resolveApp(
  p: Exclude<Parsed, { help: true } | { error: string }>,
  root: string,
  cwd: string,
  run: Docker,
): Promise<{ manifest: AppManifest; image: string } | { lines: string[] }> {
  let manifestPath = p.manifestFile ? path.resolve(cwd, p.manifestFile) : undefined;
  let image = p.image;
  if (!manifestPath) {
    const dir = APP_ID.test(p.target!) ? path.join(root, EXTERNAL_APPS_DIR, p.target!) : undefined;
    if (dir && existsSync(dir)) {
      manifestPath = path.join(dir, MANIFEST_FILE);
      try {
        image = (JSON.parse(readFileSync(path.join(dir, EXTERNAL_SOURCE_FILE), "utf8")) as { image?: string }).image;
      } catch {
        return { lines: [`${EXTERNAL_APPS_DIR}/${p.target}/${EXTERNAL_SOURCE_FILE} is missing or isn't JSON.`] };
      }
      if (!image) return { lines: [`${EXTERNAL_APPS_DIR}/${p.target}/${EXTERNAL_SOURCE_FILE} names no image.`] };
    } else {
      const read = readImageManifest(p.target!, run);
      if (!read.ok) return { lines: read.lines };
      return { manifest: read.manifest, image: p.target! };
    }
  }
  let value: unknown;
  try {
    value = await loadManifestFile(manifestPath, { jsonOnly: true });
  } catch (error) {
    return { lines: [`can't read ${path.relative(cwd, manifestPath)}: ${(error as Error).message}`] };
  }
  const result = validateManifest(value);
  if (!result.ok) {
    return {
      lines: [
        `✖ ${path.relative(cwd, manifestPath)}: ${result.problems.length} problem(s)`,
        formatProblems(result.problems),
      ],
    };
  }
  return { manifest: result.manifest, image: image! };
}

/** `platform app compose …`; null when the arguments don't fit (the caller prints the usage). */
export async function composeCommand(
  args: string[],
  root: string,
  cwd: string,
  run: Docker = docker,
): Promise<{ ok: boolean; lines: string[] } | null> {
  const p = parseComposeArgs(args);
  if ("help" in p) return { ok: true, lines: COMPOSE_HELP };
  if ("error" in p) return { ok: false, lines: [p.error, "", ...COMPOSE_HELP.slice(0, 1)] };

  const app = await resolveApp(p, root, cwd, run);
  if ("lines" in app) return { ok: false, lines: [...app.lines, "Nothing was written."] };
  const built = buildCompose(app.manifest, {
    env: p.env,
    image: app.image,
    workerImages: p.workerImages,
    scopes: p.scopes,
    migrateCommand: p.migrateCommand,
  });
  if (!built.ok) return { ok: false, lines: [...built.lines, "Nothing was written."] };

  const out = path.resolve(cwd, p.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, built.file.yaml);
  const { file } = built;
  return {
    ok: true,
    lines: [
      `✔ wrote ${path.relative(cwd, out) || out} (project ${file.project})`,
      "",
      "Gateway upstream (for the edge config, set by the owner):",
      `  ${file.upstream.variable}=${file.upstream.value}`,
      "",
      "Variables `docker compose up` requires (names only; values are the owner's):",
      ...file.variables.map((v) => `  ${v.name}  (${v.for.join(", ")})`),
      ...(file.migratorVariable
        ? [
            "",
            "Only for the migration, supplied inline for that one command (not in the runtime env file):",
            `  ${file.migratorVariable}=… docker compose -p ${file.project} -f ${path.relative(cwd, out) || out} --profile migrate run --rm migrate`,
          ]
        : []),
    ],
  };
}
