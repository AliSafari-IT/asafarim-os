/**
 * `platform manifest review [<id>…] [--json] [--strict] [--root <dir>]` (P7.2, part 1).
 *
 * ADR 0001 §10 item 2: compare what an app's manifest declares with what its code does, and report the
 * gaps. This part is deterministic (no AI) and advisory: it prints findings and exits 0, unless
 * `--strict` is given. It reads `apps/<id>/platform.app.json` and the app's source as text, and never
 * executes app code.
 *
 * Findings:
 * - `event-schema-missing` / `event-schema-invalid`: a published event's schema file isn't there, or
 *   isn't a JSON object.
 * - `permission-never-checked`: a declared permission appears neither in the app's code nor on a
 *   manifest route, so nothing ever asks for it.
 * - `route-unguarded`: a Next.js route handler (`app/**\/route.ts`) answers a method that no manifest
 *   route covers with a permission or `expose: false`, the path isn't public, and neither the file nor
 *   any app file it imports (`@/…` or relative, transitively) names one of the app's permissions. A
 *   text match can't prove the check runs on every path, so it reads "possibly".
 *
 * Sign-in plumbing is not a finding: Auth.js's own endpoints under `/api/auth/` and the SDK's session
 * hand-off (`createSessionHandler`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { HTTP_METHODS, validateManifest, type AppManifest } from "@asafarim/app-manifest";
import { MANIFEST_FILE } from "./sync.ts";

export type FindingKind =
  "event-schema-missing" | "event-schema-invalid" | "permission-never-checked" | "route-unguarded";

export interface Finding {
  app: string;
  kind: FindingKind;
  /** What the finding is about: an event type, a permission key, or `METHOD /path`. */
  subject: string;
  /** The file it points at, relative to the workspace root, when there is one. */
  file?: string;
  message: string;
}

export interface AppReview {
  app: string;
  findings: Finding[];
  /** Route handlers looked at, and how many were skipped as sign-in plumbing. */
  handlers: number;
  plumbing: number;
}

/** Folders that aren't the app's runtime code. */
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", "test", "e2e", "fixtures", "events"]);
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MANIFEST_SOURCE = /^platform\.app\.(?:ts|js|mjs|json)$/;
const ROUTE_FILE = /^route\.[cm]?[jt]sx?$/;

/** The app's runtime source files (no tests, no manifest), relative to `appDir`, sorted. */
export function sourceFiles(appDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full);
      } else if (
        entry.isFile() &&
        SOURCE_FILE.test(entry.name) &&
        !TEST_FILE.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !(dir === appDir && MANIFEST_SOURCE.test(entry.name))
      ) {
        out.push(path.relative(appDir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(appDir);
  return out.sort();
}

/**
 * The URL a route handler file answers, from its path under `app/`: route groups `(x)` and parallel
 * slots `@x` drop out; dynamic segments stay as written (`[id]`, `[...path]`, `[[...path]]`).
 * Undefined for a file outside `app/` or not named `route.*`.
 */
export function routeUrl(relFile: string): string | undefined {
  const parts = relFile.split("/");
  if (parts[0] !== "app" || !ROUTE_FILE.test(parts.at(-1) ?? "")) return undefined;
  const segments = parts.slice(1, -1).filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  return `/${segments.join("/")}`;
}

/**
 * Concrete paths a route URL answers, for matching against manifest globs: `[id]` → one segment,
 * `[...x]` → one and two segments, `[[...x]]` → none, one and two.
 */
export function samplePaths(url: string): string[] {
  let forms: string[][] = [[]];
  for (const seg of url.split("/").filter(Boolean)) {
    let options: string[][];
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) options = [[], ["x"], ["x", "y"]];
    else if (/^\[\.\.\.[^\]]+\]$/.test(seg)) options = [["x"], ["x", "y"]];
    else if (/^\[[^\]]+\]$/.test(seg)) options = [["x"]];
    else options = [[seg]];
    forms = forms.flatMap((f) => options.map((o) => [...f, ...o]));
  }
  return [...new Set(forms.map((f) => `/${f.join("/")}`))];
}

/**
 * A manifest route glob as a regular expression: `*` is one segment, `**` any depth, and a trailing
 * `/**` also matches the bare directory. The same rule as core-api's gateway (`routeRegex`), which the
 * CLI can't import (tools don't depend on core).
 */
export function globRegex(pattern: string): RegExp {
  const re = pattern
    .split("/**")
    .map((part) =>
      part
        .split("*")
        .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join("(?:/.*)?");
  return new RegExp(`^${re}$`);
}

/** The HTTP methods a route file exports (`export function GET`, `export const POST = …`, `export { GET }`). */
export function exportedMethods(text: string): string[] {
  const found = new Set<string>();
  for (const m of HTTP_METHODS) {
    const decl = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+|const\\s+|let\\s+|var\\s+)${m}\\b`);
    const list = new RegExp(`export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`);
    if (decl.test(text) || list.test(text)) found.add(m);
  }
  return HTTP_METHODS.filter((m) => found.has(m));
}

/** True when `text` holds `key` as a whole string literal ('key', "key" or `key`). */
export function mentionsKey(text: string, key: string): boolean {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(["'\`])${k}\\1`).test(text);
}

/** Module specifiers of the app's own imports: `@/…` (the app root) and relative ones. */
export function localImports(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']((?:@\/|\.{1,2}\/)[^"']+)["']/g;
  for (const m of text.matchAll(re)) out.add(m[1]!);
  return [...out];
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Resolve an `@/…` or relative specifier from `fromRel` to one of the app's `known` files, or undefined. */
export function resolveImport(fromRel: string, spec: string, known: Set<string>): string | undefined {
  const base = spec.startsWith("@/")
    ? path.posix.normalize(spec.slice(2))
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (base.startsWith("..")) return undefined;
  const stem = base.replace(/\.[cm]?js$/, "");
  for (const candidate of [base, stem]) {
    for (const ext of EXTENSIONS) if (known.has(candidate + ext)) return candidate + ext;
    for (const ext of EXTENSIONS.slice(1)) if (known.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
  }
  return undefined;
}

const SESSION_HANDOFF = /\bcreateSessionHandler\s*\(/;

/** Review one app folder. `rootDir` is only used to print file paths relative to the workspace. */
export function reviewApp(appDir: string, manifest: AppManifest, rootDir: string): AppReview {
  const app = manifest.id;
  const rel = (abs: string) => path.relative(rootDir, abs).split(path.sep).join("/");
  const findings: Finding[] = [];

  // 1. Published event types have a schema file that is a JSON object.
  for (const ev of manifest.events?.publishes ?? []) {
    const file = path.resolve(appDir, ev.schema);
    const inside = !path.relative(appDir, file).startsWith("..");
    if (!inside || !existsSync(file) || !statSync(file).isFile()) {
      findings.push({
        app,
        kind: "event-schema-missing",
        subject: ev.type,
        file: rel(file),
        message: `published event ${ev.type} has no schema file at ${ev.schema}`,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      findings.push({
        app,
        kind: "event-schema-invalid",
        subject: ev.type,
        file: rel(file),
        message: `the schema of ${ev.type} isn't valid JSON (${(error as Error).message})`,
      });
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      findings.push({
        app,
        kind: "event-schema-invalid",
        subject: ev.type,
        file: rel(file),
        message: `the schema of ${ev.type} isn't a JSON Schema object`,
      });
    }
  }

  // The app's code, read once.
  const files = sourceFiles(appDir).map((f) => ({ rel: f, text: readFileSync(path.join(appDir, f), "utf8") }));
  const keys = manifest.permissions.map((p) => p.key);
  const textOf = new Map(files.map((f) => [f.rel, f.text]));
  const known = new Set(files.map((f) => f.rel));
  /** The file and the app files it imports, transitively: a check often lives in a shared helper. */
  const reachable = (start: string): string[] => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const spec of localImports(textOf.get(cur) ?? "")) {
        const hit = resolveImport(cur, spec, known);
        if (hit && !seen.has(hit)) queue.push(hit);
      }
    }
    return [...seen];
  };
  const routes = manifest.routes ?? [];

  // 2. Every declared permission is asked for somewhere: in code, or by a gateway route.
  for (const key of keys) {
    const inCode = files.some((f) => mentionsKey(f.text, key));
    const onRoute = routes.some((r) => r.permission === key);
    if (!inCode && !onRoute) {
      findings.push({
        app,
        kind: "permission-never-checked",
        subject: key,
        message: `permission ${key} is declared but no code or manifest route ever asks for it`,
      });
    }
  }

  // 3. Route handlers are guarded by the gateway, are public, or check a permission themselves.
  const publicRes = manifest.auth.publicPaths.map(globRegex);
  let handlers = 0;
  let plumbing = 0;
  for (const f of files) {
    const url = routeUrl(f.rel);
    if (url === undefined) continue;
    handlers++;
    if (url === "/api/auth" || url.startsWith("/api/auth/") || SESSION_HANDOFF.test(f.text)) {
      plumbing++;
      continue;
    }
    if (reachable(f.rel).some((r) => keys.some((k) => mentionsKey(textOf.get(r) ?? "", k)))) continue;
    const paths = samplePaths(url);
    for (const method of exportedMethods(f.text)) {
      const covered = paths.every(
        (p) =>
          publicRes.some((re) => re.test(p)) ||
          routes.some(
            (r) =>
              (!r.methods || r.methods.includes(method as never)) &&
              (r.expose === false || r.permission !== undefined) &&
              globRegex(r.path).test(p),
          ),
      );
      if (!covered) {
        findings.push({
          app,
          kind: "route-unguarded",
          subject: `${method} ${url}`,
          file: rel(path.join(appDir, f.rel)),
          message: `${method} ${url} is possibly unguarded: no manifest route with a permission or expose: false covers it, it isn't public, and neither the handler nor the app files it imports name one of the app's permissions`,
        });
      }
    }
  }

  return { app, findings, handlers, plumbing };
}

export interface ReviewOptions {
  ids: string[];
  json: boolean;
  strict: boolean;
  root?: string;
}

export function parseReviewArgs(args: string[]): ReviewOptions | null {
  const opts: ReviewOptions = { ids: [], json: false, strict: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") opts.json = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--root" && args[i + 1]) opts.root = args[++i];
    else if (a.startsWith("-")) return null;
    else opts.ids.push(a);
  }
  return opts;
}

export interface ReviewResult {
  ok: boolean;
  lines: string[];
}

/** Review the named apps under `<root>/apps/`, or all of them. */
export function reviewCommand(args: string[], cwd: string, findRoot: () => string): ReviewResult | null {
  const opts = parseReviewArgs(args);
  if (!opts) return null;
  const root = opts.root ? path.resolve(cwd, opts.root) : findRoot();
  const appsDir = path.join(root, "apps");
  const available = existsSync(appsDir)
    ? readdirSync(appsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(appsDir, e.name, MANIFEST_FILE)))
        .map((e) => e.name)
        .sort()
    : [];
  const ids = opts.ids.length > 0 ? opts.ids : available;
  const unknown = ids.filter((id) => !available.includes(id));
  if (unknown.length > 0) {
    return { ok: false, lines: [`✖ no apps/<id>/${MANIFEST_FILE} for: ${unknown.join(", ")}`] };
  }

  const reviews: AppReview[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const file = path.join(appsDir, id, MANIFEST_FILE);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`✖ apps/${id}/${MANIFEST_FILE}: can't read it (${(error as Error).message})`);
      continue;
    }
    const result = validateManifest(value);
    if (!result.ok) {
      errors.push(`✖ apps/${id}/${MANIFEST_FILE}: not a valid manifest; run platform manifest validate first`);
      continue;
    }
    reviews.push(reviewApp(path.join(appsDir, id), result.manifest, root));
  }

  const findings = reviews.flatMap((r) => r.findings);
  const ok = errors.length === 0 && !(opts.strict && findings.length > 0);
  if (opts.json) {
    return { ok, lines: [JSON.stringify({ reviews, errors }, null, 2)] };
  }
  const lines: string[] = [...errors];
  for (const r of reviews) {
    const head = `${r.findings.length === 0 ? "✔" : "⚠"} ${r.app}: ${r.findings.length} finding(s); ${r.handlers} route handler(s), ${r.plumbing} sign-in plumbing`;
    lines.push(head);
    for (const f of r.findings) lines.push(`  - [${f.kind}] ${f.message}${f.file ? ` (${f.file})` : ""}`);
  }
  if (reviews.length === 0 && errors.length === 0) lines.push("No apps to review.");
  lines.push(
    findings.length === 0
      ? "Manifest review: nothing to report."
      : `Manifest review: ${findings.length} finding(s). Advisory${opts.strict ? " (--strict: failing)" : "; it doesn't fail the build"}.`,
  );
  return { ok, lines };
}
