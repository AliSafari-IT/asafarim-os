/**
 * `platform boundaries`: the rule "the core never imports an app" as a check.
 *
 * Every source file under `core/` and `packages/` is scanned for import or
 * require specifiers that reach into `apps/`: a relative path that resolves
 * inside `apps/`, or the package name of a workspace that lives in `apps/`.
 * Apps may import packages, never the other way round.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface BoundaryViolation {
  file: string;
  line: number;
  specifier: string;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);
const SPECIFIER =
  /(?:\bimport\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?|\bexport\s+(?:type\s+)?[^'"]*?\sfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(path.join(dir, entry.name));
    } else if (SOURCE.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Package names declared by the workspaces under `apps/`. */
export function appPackageNames(root: string): Set<string> {
  const names = new Set<string>();
  const appsDir = path.join(root, "apps");
  if (!existsSync(appsDir)) return names;
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    const pkg = path.join(appsDir, entry.name, "package.json");
    if (entry.isDirectory() && existsSync(pkg)) {
      const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name;
      if (name) names.add(name);
    }
  }
  return names;
}

export function findBoundaryViolations(root: string): BoundaryViolation[] {
  const appsDir = path.join(root, "apps") + path.sep;
  const appPackages = appPackageNames(root);
  const violations: BoundaryViolation[] = [];
  for (const top of ["core", "packages"]) {
    for (const file of files(path.join(root, top))) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        for (const match of text.matchAll(SPECIFIER)) {
          const spec = match[1]!;
          const intoApps = spec.startsWith(".")
            ? (path.resolve(path.dirname(file), spec) + path.sep).startsWith(appsDir)
            : [...appPackages].some((name) => spec === name || spec.startsWith(`${name}/`));
          if (intoApps) {
            violations.push({
              file: path.relative(root, file).split(path.sep).join("/"),
              line: i + 1,
              specifier: spec,
            });
          }
        }
      });
    }
  }
  return violations;
}

export function boundariesCommand(root: string): { ok: boolean; lines: string[] } {
  const violations = findBoundaryViolations(root);
  if (violations.length === 0) return { ok: true, lines: ["✔ core/ and packages/ import nothing from apps/."] };
  return {
    ok: false,
    lines: [
      `✖ ${violations.length} import(s) from apps/ in core/ or packages/ (the core never imports an app):`,
      ...violations.map((v) => `  - ${v.file}:${v.line}  ${v.specifier}`),
    ],
  };
}
