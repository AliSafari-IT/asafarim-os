/**
 * `platform sync`: turns every app's manifest into the platform wiring under
 * `generated/platform/` (compose services, gateway sites, image build targets,
 * CI filters, the launcher registry). `--check` fails when the committed
 * output differs from what the manifests would generate, so CI catches drift.
 *
 * Bootstrap stage: no generators exist yet, so the only valid state is
 * "no manifests and no generated files". Manifests make `sync` refuse rather
 * than silently generate nothing; the generators replace that branch.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Files that document the directory rather than being generator output. */
const NOT_GENERATED = new Set(["README.md", ".gitkeep"]);

export const MANIFEST_FILE = "platform.app.json";

export interface SyncResult {
  ok: boolean;
  lines: string[];
}

/** The workspace root: the nearest ancestor holding pnpm-workspace.yaml. */
export function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml found above ${from}`);
    dir = parent;
  }
}

/** `apps/<id>/platform.app.json` files, sorted by app folder. */
export function discoverManifests(root: string): string[] {
  const appsDir = path.join(root, "apps");
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsDir, entry.name, MANIFEST_FILE))
    .filter((file) => existsSync(file))
    .sort();
}

/** Files under generated/platform/ that a generator would own. */
export function generatedFiles(root: string): string[] {
  const dir = path.join(root, "generated", "platform");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !NOT_GENERATED.has(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

export function sync(root: string, opts: { check: boolean }): SyncResult {
  const manifests = discoverManifests(root).map((file) => path.relative(root, file).split(path.sep).join("/"));
  const generated = generatedFiles(root);
  const lines = [`Found ${manifests.length} app manifest(s).`, ...manifests.map((m) => `  - ${m}`)];

  if (manifests.length > 0) {
    lines.push("No generators exist yet, so these manifests can't be turned into platform wiring.");
    return { ok: false, lines };
  }
  if (generated.length > 0) {
    lines.push(
      opts.check
        ? "Drift: generated/platform/ holds files that no manifest produces:"
        : "generated/platform/ holds files that no manifest produces; remove them:",
      ...generated.map((g) => `  - ${g}`),
    );
    return { ok: false, lines };
  }
  lines.push(opts.check ? "generated/platform/ is up to date." : "Nothing to generate.");
  return { ok: true, lines };
}
