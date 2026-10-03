/**
 * `platform manifest validate <file>` and `platform manifest compile <file>`.
 *
 * A manifest file is either JSON (`platform.app.json`) or a module whose
 * default export is the manifest (`platform.app.ts`, usually
 * `export default defineApp({...})`). The CLI runs under tsx, so TypeScript
 * modules load directly.
 *
 * Security (#767): loading a .ts/.js manifest EXECUTES it. That is only for
 * in-repo, trusted apps: a module manifest is refused unless it lies inside
 * the workspace the command runs in. `sync --against` and any install path
 * read `platform.app.json` only (`jsonOnly`) and never execute app code.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST_JSON_FILE, ManifestError, formatProblems, validateManifest } from "@asafarim/app-manifest";

export interface CommandResult {
  ok: boolean;
  lines: string[];
}

export interface LoadOptions {
  /** Only `.json` is read; a module manifest is refused, never executed (--against, installs). */
  jsonOnly?: boolean;
  /** A module manifest must lie inside this directory to be executed. */
  workspaceRoot?: string;
}

/** The nearest directory above `from` with a pnpm-workspace.yaml (the trusted workspace). */
export function workspaceRootOf(from: string): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Real paths on both sides: a symlink inside the workspace that points outside
 * it (or a symlinked workspace root) must not count as "inside". A path that
 * can't be resolved is treated as outside.
 */
function isInside(file: string, root: string): boolean {
  let realFile: string;
  let realRoot: string;
  try {
    realFile = realpathSync(path.resolve(file));
    realRoot = realpathSync(path.resolve(root));
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, realFile);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Read a manifest file into a plain value (not yet validated). */
export async function loadManifestFile(file: string, opts: LoadOptions = {}): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
  if (opts.jsonOnly) {
    throw new Error(
      "only platform.app.json is read here, and manifest code is never executed; compile it in its own repository first (platform manifest compile)",
    );
  }
  if (!opts.workspaceRoot || !isInside(file, opts.workspaceRoot)) {
    throw new Error(
      "refusing to execute a manifest module outside this workspace" +
        (opts.workspaceRoot ? ` (${opts.workspaceRoot})` : "") +
        "; module manifests are for in-repo, trusted apps only",
    );
  }
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: unknown };
  if (mod.default === undefined) throw new Error("the module has no default export");
  return mod.default;
}

/** Load and validate; a `defineApp` that throws reports its problems like any other. */
async function check(file: string, cwd: string): Promise<CommandResult & { manifest?: unknown }> {
  const shown = (path.relative(cwd, path.resolve(cwd, file)) || file).split(path.sep).join("/");
  let value: unknown;
  try {
    value = await loadManifestFile(path.resolve(cwd, file), { workspaceRoot: workspaceRootOf(cwd) });
  } catch (error) {
    if (error instanceof ManifestError) {
      return { ok: false, lines: [`✖ ${shown}: ${error.problems.length} problem(s)`, formatProblems(error.problems)] };
    }
    return { ok: false, lines: [`✖ ${shown}: can't read the manifest (${(error as Error).message})`] };
  }
  const result = validateManifest(value);
  if (!result.ok) {
    return { ok: false, lines: [`✖ ${shown}: ${result.problems.length} problem(s)`, formatProblems(result.problems)] };
  }
  const m = result.manifest;
  return {
    ok: true,
    manifest: m,
    lines: [
      `✔ ${shown}: valid manifest for ${m.id}@${m.version}`,
      `  ${m.permissions.length} permission(s), ${m.roles.length} role(s), ${m.routes?.length ?? 0} route(s), ` +
        `${m.events?.publishes?.length ?? 0} published / ${m.events?.subscribes?.length ?? 0} subscribed event(s)`,
    ],
  };
}

export async function validateCommand(file: string, cwd = process.cwd()): Promise<CommandResult> {
  const { ok, lines } = await check(file, cwd);
  return { ok, lines };
}

/** Validate a manifest and write it as `platform.app.json` next to the source. */
export async function compileCommand(file: string, cwd = process.cwd()): Promise<CommandResult> {
  const result = await check(file, cwd);
  if (!result.ok) return { ok: false, lines: result.lines };
  const out = path.join(path.dirname(path.resolve(cwd, file)), MANIFEST_JSON_FILE);
  writeFileSync(out, `${JSON.stringify(result.manifest, null, 2)}\n`);
  return { ok: true, lines: [...result.lines, `  wrote ${path.relative(cwd, out)}`] };
}
