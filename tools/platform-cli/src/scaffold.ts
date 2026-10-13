/**
 * `platform app new <id> [--name "<Display name>"] [--root <dir>]` (P7.1): write a minimal app to
 * `<root>/apps/<id>/` from the files under `templates/app/`.
 *
 * Everything is checked before anything is written: the id (shape, the manifest schema's own rules,
 * reserved and already-taken ids) and the rendered manifest. The folder is then written next to its
 * destination and renamed into place, so a failure never leaves a partial `apps/<id>/` behind.
 *
 * Templates are plain files; `{{id}}`, `{{name}}`, `{{glyph}}` and `{{port}}` are replaced, and a
 * `.tmpl` suffix is dropped from the file name. The scaffold only writes files: installing the app in
 * core-api, creating its OIDC client and deploying it stay separate steps.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatProblems, validateManifest } from "@asafarim/app-manifest";
import { EXTERNAL_APPS_DIR, MANIFEST_FILE } from "./sync.ts";

export interface ScaffoldResult {
  ok: boolean;
  lines: string[];
}

export interface ScaffoldOptions {
  id: string;
  /** Display name; defaults to the id in title case. */
  name?: string;
}

/** The file operations of a scaffold, replaceable in tests to make a write fail half way. */
export interface ScaffoldIo {
  mkdir: (dir: string) => void;
  write: (file: string, content: string) => void;
  rename: (from: string, to: string) => void;
  remove: (target: string) => void;
}

const nodeIo: ScaffoldIo = {
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  write: (file, content) => writeFileSync(file, content),
  rename: (from, to) => renameSync(from, to),
  remove: (target) => rmSync(target, { recursive: true, force: true }),
};

export const TEMPLATE_DIR = fileURLToPath(new URL("../templates/app/", import.meta.url));
const TEMPLATE_SUFFIX = ".tmpl";
const FIRST_DEV_PORT = 4120;
const PORT_STEP = 10;

/** Enough to keep the id safe as a folder name; the manifest schema decides everything else. */
const PATH_SAFE_ID = /^[a-z0-9-]{1,64}$/;
/** Letters, digits, spaces, dots and dashes: nothing that needs escaping in JSON, TypeScript or JSX. */
const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .-]{0,63}$/u;

export function defaultName(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** 1–3 upper-case characters for the launcher tile: the initials of the id's words, or its first two letters. */
export function defaultGlyph(id: string): string {
  const words = id.split("-").filter(Boolean);
  const glyph = words.length > 1 ? words.map((w) => w.charAt(0)).join("") : id.slice(0, 2);
  return glyph.slice(0, 3).toUpperCase();
}

/** The next free dev port: 10 above the highest `--port` in an existing app's scripts (never below 4120). */
export function nextDevPort(root: string): number {
  const appsDir = path.join(root, "apps");
  let highest = FIRST_DEV_PORT - PORT_STEP;
  if (existsSync(appsDir)) {
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const pkg = JSON.parse(readFileSync(path.join(appsDir, entry.name, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        };
        for (const script of Object.values(pkg.scripts ?? {})) {
          const port = /--port\s+(\d+)/.exec(script)?.[1];
          if (port) highest = Math.max(highest, Number(port));
        }
      } catch {
        // no package.json, or not JSON: not an app that holds a port
      }
    }
  }
  return highest + PORT_STEP;
}

function templateFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? templateFiles(path.join(dir, entry.name), base)
        : [path.relative(base, path.join(dir, entry.name))],
    )
    .sort();
}

/** Replace every `{{key}}`; a placeholder without a value is a bug in the template, not something to leave behind. */
export function renderTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`unknown placeholder {{${key}}} in a template`);
    return value;
  });
}

/** `[relative path, content]` of every file the app consists of. */
export function renderApp(values: Record<string, string>, templateDir = TEMPLATE_DIR): [string, string][] {
  return templateFiles(templateDir).map((rel) => {
    const out = rel.endsWith(TEMPLATE_SUFFIX) ? rel.slice(0, -TEMPLATE_SUFFIX.length) : rel;
    return [out.split(path.sep).join("/"), renderTemplate(readFileSync(path.join(templateDir, rel), "utf8"), values)];
  });
}

function refuse(...lines: string[]): ScaffoldResult {
  return { ok: false, lines: [...lines, "Nothing was written."] };
}

export function scaffoldApp(
  root: string,
  options: ScaffoldOptions,
  io: ScaffoldIo = nodeIo,
  templateDir = TEMPLATE_DIR,
): ScaffoldResult {
  const { id } = options;
  if (!PATH_SAFE_ID.test(id)) {
    return refuse(`"${id}" is not a usable app id: use lower-case letters, digits and single dashes, e.g. "my-app".`);
  }
  const name = options.name ?? defaultName(id);
  if (!DISPLAY_NAME.test(name)) {
    return refuse(`"${name}" is not a usable display name: 1–64 letters, digits, spaces, dots or dashes.`);
  }

  const values = { id, name, glyph: defaultGlyph(id), port: String(nextDevPort(root)) };
  const files = renderApp(values, templateDir);

  // The same schema the platform uses decides the id (shape, length, reserved) and the rest of the manifest.
  const manifestText = files.find(([file]) => file === MANIFEST_FILE)?.[1];
  if (manifestText === undefined) throw new Error(`the templates have no ${MANIFEST_FILE}`);
  const checked = validateManifest(JSON.parse(manifestText));
  if (!checked.ok) {
    return refuse(`"${id}" can't be scaffolded: the manifest would not validate.`, formatProblems(checked.problems));
  }

  for (const dir of ["apps", EXTERNAL_APPS_DIR, "core"]) {
    if (existsSync(path.join(root, dir, id))) {
      const what = dir === "core" ? "a core service" : `an app in ${dir}/`;
      return refuse(`"${id}" is taken: ${dir}/${id} already exists (${what}).`);
    }
  }

  const appsDir = path.join(root, "apps");
  const target = path.join(appsDir, id);
  const staging = path.join(appsDir, `.${id}.new-${process.pid}`);
  const createdApps = !existsSync(appsDir);
  try {
    io.mkdir(staging);
    for (const [rel, content] of files) {
      const file = path.join(staging, rel);
      io.mkdir(path.dirname(file));
      io.write(file, content);
    }
    io.rename(staging, target);
  } catch (error) {
    io.remove(staging);
    if (createdApps) io.remove(appsDir);
    return refuse(`Writing apps/${id} failed: ${(error as Error).message}`);
  }

  return {
    ok: true,
    lines: [
      `✔ created apps/${id}/ (${files.length} files) for "${name}"`,
      ...files.map(([rel]) => `  ${rel}`),
      "",
      "Next:",
      "  pnpm install  # link the new workspace package",
      "  pnpm platform sync  # generate its launcher tile and gateway site",
      `  pnpm platform app install ${id}  # register it with core-api (needs \`pnpm dev\` running)`,
      `  pnpm --filter @asafarim/${id} dev  # http://localhost:${values.port}`,
    ],
  };
}

/** `platform app new <id> [--name <name>] [--root <dir>]`; null when the arguments don't fit. */
export function newAppCommand(args: string[], cwd: string, defaultRoot: () => string): ScaffoldResult | null {
  const [id, ...rest] = args;
  if (!id || id.startsWith("--")) return null;
  let name: string | undefined;
  let rootDir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name" && rest[i + 1] !== undefined) name = rest[++i];
    else if (rest[i] === "--root" && rest[i + 1] !== undefined) rootDir = rest[++i];
    else return null;
  }
  return scaffoldApp(rootDir ? path.resolve(cwd, rootDir) : defaultRoot(), { id, name });
}
