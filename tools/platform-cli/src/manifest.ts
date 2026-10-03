/**
 * `platform manifest validate <file>` and `platform manifest compile <file>`.
 *
 * A manifest file is either JSON (`platform.app.json`) or a module whose
 * default export is the manifest (`platform.app.ts`, usually
 * `export default defineApp({...})`). The CLI runs under tsx, so TypeScript
 * modules load directly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST_JSON_FILE, ManifestError, formatProblems, validateManifest } from "@asafarim/app-manifest";

export interface CommandResult {
  ok: boolean;
  lines: string[];
}

/** Read a manifest file into a plain value (not yet validated). */
export async function loadManifestFile(file: string): Promise<unknown> {
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as { default?: unknown };
  if (mod.default === undefined) throw new Error("the module has no default export");
  return mod.default;
}

/** Load and validate; a `defineApp` that throws reports its problems like any other. */
async function check(file: string, cwd: string): Promise<CommandResult & { manifest?: unknown }> {
  const shown = (path.relative(cwd, path.resolve(cwd, file)) || file).split(path.sep).join("/");
  let value: unknown;
  try {
    value = await loadManifestFile(path.resolve(cwd, file));
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
