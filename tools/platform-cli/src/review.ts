/**
 * `platform manifest review [<id>…] [--json | --markdown] [--strict] [--root <dir>]` (P7.2, part 1).
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
 * - `event-not-declared` (P7.2 part 2a): the app's code names an event type in its own namespace
 *   (`<id>.<entity>.<verb>.v<N>`, as a whole string literal) that the manifest doesn't publish, so
 *   core-api would refuse it and no subscriber can declare it.
 * - `event-handler-missing` (P7.2 part 2a): a declared subscription's `handler` path isn't served by
 *   any of the app's route files, and the app's code never names the event type either.
 * - `permission-not-declared`: the code checks a permission in the app's own namespace (a whole string
 *   literal `<id>.…` as the first or second argument of a check call such as `gate`, `require`, `can`,
 *   or `includes`/`has` on a permission or role collection) that the manifest declares neither as a
 *   permission nor as a role. Nobody
 *   can be granted it, so the check always refuses (often a typo).
 * - `secret-never-read`: a declared secret that no runtime code names (framework-read names aside).
 * - `health-route-missing`: `runtime.health.live` or `.ready` is a path no route file (`app/**\/route.ts`)
 *   answers with `GET`. core-api's health poller calls both, so the app would never read as healthy.
 *   Pages don't count: a health check wants a route handler, not a rendered page.
 * - `config-not-declared` / `config-type-mismatch`: the code reads a config key (a whole string literal
 *   passed to `config.getString`, `getInt`, `getNumber` or `getBoolean`) that the manifest's `config`
 *   doesn't declare, or declares with a type that getter refuses. The app SDK throws on both, so the
 *   call fails at runtime, only when that code path runs.
 * - `config-never-read`: a key the manifest's `config` declares that no runtime code names as a whole
 *   string literal (comments ignored). Setting its `APP_CONFIG_<KEY>` changes nothing, often because
 *   the read was renamed. An app whose code calls `config.all()` may read every key, so it gets none.
 * - `event-never-published`: a type in `events.publishes` that no runtime code names as a whole string
 *   literal (comments ignored). Subscribers wait for an event that never comes, and a renamed type
 *   leaves the old declaration and schema behind.
 * - `route-not-served`: a manifest route with a `permission` that no route file (`app/**\/route.ts`)
 *   or page (`app/**\/page.tsx`) serves, or, when the route lists `methods`, none of the files that
 *   serve it answers one of them (pages answer `GET` and `HEAD`; a route file exporting `GET` also
 *   answers `HEAD`, and any route file answers `OPTIONS`). The gateway's check then guards nothing,
 *   usually because the handler moved, and the moved handler may be left without it.
 *
 * Output: text lines by default; `--json` prints `{ reviews, errors }`; `--markdown` (P7.2 part 2b)
 * prints the report CI posts as one advisory pull request comment, updated in place (see
 * `renderMarkdown`). The two are mutually exclusive. Exit codes don't depend on the format.
 *
 * Sign-in plumbing is not a finding: Auth.js's own endpoints under `/api/auth/` and the SDK's session
 * hand-off (`createSessionHandler`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { HTTP_METHODS, validateManifest, type AppManifest } from "@asafarim/app-manifest";
import { MANIFEST_FILE } from "./sync.ts";

export type FindingKind =
  | "event-schema-missing"
  | "event-schema-invalid"
  | "permission-never-checked"
  | "route-unguarded"
  | "event-not-declared"
  | "event-handler-missing"
  | "permission-not-declared"
  | "secret-never-read"
  | "health-route-missing"
  | "config-not-declared"
  | "config-type-mismatch"
  | "config-never-read"
  | "event-never-published"
  | "route-not-served";

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
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "fixtures",
]);
/** Folders skipped only at the app's root: `events/` holds the JSON schemas, but `app/events/` can hold handlers. */
const SKIP_ROOT_DIRS = new Set(["events"]);
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MANIFEST_SOURCE = /^platform\.app\.(?:ts|js|mjs|json)$/;
const ROUTE_FILE = /^route\.[cm]?[jt]sx?$/;
const PAGE_FILE = /^page\.[cm]?[jt]sx?$/;

/** The app's runtime source files (no tests, no manifest), relative to `appDir`, sorted. */
export function sourceFiles(appDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skip = SKIP_DIRS.has(entry.name) || (dir === appDir && SKIP_ROOT_DIRS.has(entry.name));
        if (!skip && !entry.name.startsWith(".")) walk(full);
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
  return appUrl(relFile, ROUTE_FILE);
}

/** The URL a page file (`app/**\/page.tsx`) renders, by the same rules as `routeUrl`. */
export function pageUrl(relFile: string): string | undefined {
  return appUrl(relFile, PAGE_FILE);
}

function appUrl(relFile: string, fileName: RegExp): string | undefined {
  const parts = relFile.split("/");
  if (parts[0] !== "app" || !fileName.test(parts.at(-1) ?? "")) return undefined;
  const segments = parts.slice(1, -1).filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  return `/${segments.join("/")}`;
}

/**
 * Concrete paths a manifest route glob matches, for testing against route URLs: `*` → `x`, and each
 * `/**` → nothing and one segment. With `samplePaths` the other way round, a glob and a route URL
 * overlap when either side's samples match the other.
 */
export function globSamples(pattern: string): string[] {
  let forms = [""];
  pattern.split("/**").forEach((part, i) => {
    const lit = part.replace(/\*/g, "x");
    forms = i === 0 ? [lit] : forms.flatMap((f) => [f + lit, `${f}/x${lit}`]);
  });
  return [...new Set(forms.map((f) => f || "/"))];
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
 * The paths a Next.js route URL answers, as a regular expression: `[id]` → one segment, `[...x]` → one
 * or more, `[[...x]]` → none or more.
 */
export function routeUrlRegex(url: string): RegExp {
  let re = "";
  for (const seg of url.split("/").filter(Boolean)) {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) re += "(?:/[^/]+)*";
    else if (/^\[\.\.\.[^\]]+\]$/.test(seg)) re += "(?:/[^/]+)+";
    else if (/^\[[^\]]+\]$/.test(seg)) re += "/[^/]+";
    else re += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  }
  return new RegExp(`^${re || "/"}$`);
}

/** How Next.js ranks a URL segment when several routes match: static, then `[x]`, `[...x]`, `[[...x]]`. */
function segmentRank(seg: string): number {
  if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return 3;
  if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return 2;
  if (/^\[[^\]]+\]$/.test(seg)) return 1;
  return 0;
}

/**
 * Orders two route URLs that match the same path, most specific first, the way Next.js picks the one
 * that answers: segment by segment, a static segment beats a dynamic one, which beats a catch-all.
 */
export function compareRouteSpecificity(a: string, b: string): number {
  const sa = a.split("/").filter(Boolean);
  const sb = b.split("/").filter(Boolean);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const ra = i < sa.length ? segmentRank(sa[i]!) : -1;
    const rb = i < sb.length ? segmentRank(sb[i]!) : -1;
    if (ra !== rb) return ra - rb;
  }
  return 0;
}

/** Event types in `namespace` (`<ns>.<entity>.<verb>.v<N>`) that `text` holds as whole string literals. */
export function eventTypesIn(text: string, namespace: string): string[] {
  const ns = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(["'\`])(${ns}\\.[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*\\.v[1-9]\\d*)\\1`, "g");
  return [...new Set([...text.matchAll(re)].map((m) => m[2]!))];
}

/**
 * Calls that check a permission by name: the app's gate, the SDK's `access.require`, … `includes` and
 * `has` count only on a receiver named for permissions, roles or grants (`access.permissions.includes`,
 * `roles.has`), so an ordinary membership test (`enabledFeatures.includes(…)`) isn't one.
 */
export const CHECK_CALLS = ["gate", "require", "requirePermission", "hasPermission", "can", "check", "checkPermission"];
const MEMBERSHIP_CHECK = String.raw`[\w$]*(?:[Pp]erm|[Rr]ole|[Gg]rant)[\w$]*\s*\??\.\s*(?:includes|has)`;
/** `<id>.<entity>.<verb>.v<N>`: an event type, not a permission. */
const EVENT_TYPE_SHAPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9]\d*$/;
/** A last segment that names a file or a host, not a permission (`"notes.env"`, `"notes.asafarim.site"`). */
const FILE_SUFFIX = /\.(?:json|[cm]?[jt]sx?|env|md|html?|css|txt|ya?ml|sql|png|svg|ico|lock)$/;
const HOST_SUFFIX = /\.(?:site|com|net|org|io|cloud|dev|local|localhost|eu|be|nl)$/;

/**
 * `text` with its `//` and `/* *\/` comments blanked (newlines kept), leaving string literals alone, so
 * a check that only appears in a comment isn't read as code. A light scanner, not a parser: regular
 * expression literals are read as code.
 */
export function stripComments(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close === -1 ? text.length : close + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Keys in `namespace` (`<ns>.<word>[.<word>…]`, lower case) that `text` passes as a whole string literal
 * to a permission-check call (`CHECK_CALLS`, or `includes`/`has` on a permission or role collection),
 * as its first or second argument. The first argument may hold one level of parentheses
 * (`require(getSubject(), "…")`). Comments, event types, file names and host names are left out.
 */
export function checkedKeysIn(text: string, namespace: string): string[] {
  const ns = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lit = `(["'\`])(${ns}(?:\\.[a-z][a-z0-9-]*)+)\\1`;
  const callee = `(?:\\b(?:${CHECK_CALLS.join("|")})|(?<![\\w$])${MEMBERSHIP_CHECK})`;
  const firstArg = String.raw`(?:[^,()"'\`]|\([^()"'\`]*\))*`;
  const re = new RegExp(`${callee}\\s*\\(\\s*(?:${firstArg},\\s*)?${lit}`, "g");
  const keys = [...stripComments(text).matchAll(re)]
    .map((m) => m[2]!)
    .filter((k) => !EVENT_TYPE_SHAPE.test(k) && !FILE_SUFFIX.test(k) && !HOST_SUFFIX.test(k));
  return [...new Set(keys)];
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
    const decl = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${m}\\b`);
    if (decl.test(text)) found.add(m);
  }
  // `export { GET, POST as P }`: the local names in each export list.
  for (const list of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of list[1]!.split(",")) {
      const name = item.trim().split(/\s+/)[0];
      if (name && (HTTP_METHODS as readonly string[]).includes(name)) found.add(name);
    }
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
  const re = /\b(?:from|import)[\s(]*["']((?:@\/|\.{1,2}\/)[^"'\n]+)["']/g;
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

/**
 * Secret names read from the environment by a framework or the platform's own SDK, not by the app's
 * code: Auth.js, Next.js, OpenTelemetry, and `@asafarim/app-sdk` (`ASAFARIM_REGISTRY_CREDENTIAL`,
 * `ASAFARIM_NATS_PASSWORD`, …).
 */
export const FRAMEWORK_SECRET = /^(?:AUTH|NEXT|OTEL|ASAFARIM)_/;

/** True when `text` (comments ignored) names `name` as a whole word: `process.env.X`, `env["X"]`, `"X"`. */
export function mentionsName(text: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(stripComments(text));
}

/**
 * The app SDK's typed config getters and the declared types each accepts (`@asafarim/app-sdk`'s
 * `createConfig`; `getNumber` also reads an `int`). The CLI doesn't import the SDK, so this copies it.
 */
export const CONFIG_GETTERS: Record<string, readonly string[]> = {
  getString: ["string"],
  getBoolean: ["boolean"],
  getInt: ["int"],
  getNumber: ["int", "number"],
};

/**
 * `text` with the contents of every string literal blanked (quotes, length and newlines kept), so code
 * can be matched without matching what a string says. The same light scanner as `stripComments`.
 */
export function blankStrings(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < text.length) {
        out += "  ";
        i++;
      } else if (c === quote) {
        quote = undefined;
        out += c;
      } else {
        out += c === "\n" ? "\n" : " ";
      }
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/**
 * The contents of every whole string literal in `text` (comments ignored), as written between the
 * quotes. A quote inside another literal (`'publish("x")'`) is part of that literal, not a literal of
 * its own. The same light scanner as `stripComments`.
 */
export function stringLiterals(text: string): Set<string> {
  const code = stripComments(text);
  const out = new Set<string>();
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) {
        out.add(code.slice(start, i));
        quote = undefined;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      start = i + 1;
    }
  }
  return out;
}

/**
 * Config reads in `text` (comments ignored): a whole string literal, without interpolation, passed as
 * the only argument of a `CONFIG_GETTERS` call on a receiver named for config (`config.getInt("…")`,
 * `getPlatform().config.getString("…")`, `appConfig?.getBoolean('…')`). A call written inside a string
 * (an example in help text) isn't one. In source order, repeats kept.
 */
export function configReadsIn(text: string): { getter: string; key: string }[] {
  const code = stripComments(text);
  const getters = Object.keys(CONFIG_GETTERS).join("|");
  // Matched on the string-blanked text, so the call itself is code; the key is read back from `code`.
  const re = new RegExp(
    String.raw`(?<![\w$])[\w$]*[Cc]onfig\s*\??\.\s*(${getters})\s*\(\s*(["'\`])([^"'\`\n]*)\2\s*\)`,
    "g",
  );
  const reads: { getter: string; key: string }[] = [];
  for (const m of blankStrings(code).matchAll(re)) {
    const start = m.index + m[0].indexOf(m[2]!, m[0].indexOf("(")) + 1;
    const key = code.slice(start, start + m[3]!.length);
    if (key === "" || /["'`\\\n]/.test(key) || (m[2] === "`" && key.includes("${"))) continue;
    reads.push({ getter: m[1]!, key });
  }
  return reads;
}

/**
 * True when `text` (comments ignored, string contents blanked) calls `all()` on a receiver named for
 * config (`config.all()`, `getPlatform().config?.all()`): the SDK's every-key read, which can reach any
 * declared key without naming it.
 */
export function readsAllConfig(text: string): boolean {
  return /(?<![\w$])[\w$]*[Cc]onfig\s*\??\.\s*all\s*\(/.test(blankStrings(stripComments(text)));
}

/** Review one app folder. `rootDir` is only used to print file paths relative to the workspace. */
export function reviewApp(appDir: string, manifest: AppManifest, rootDir: string): AppReview {
  const app = manifest.id;
  const rel = (abs: string) => path.relative(rootDir, abs).split(path.sep).join("/");
  const findings: Finding[] = [];

  // 1. Published event types have a schema file that is a JSON object.
  for (const ev of manifest.events?.publishes ?? []) {
    const file = path.resolve(appDir, ev.schema);
    const inside = !path.relative(appDir, file).startsWith("..");
    // Read once and classify the error, rather than checking first (no check-then-use race).
    let text: string | undefined;
    if (inside) {
      try {
        text = readFileSync(file, "utf8");
      } catch {
        text = undefined; // missing, a directory, or unreadable
      }
    }
    if (text === undefined) {
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
      parsed = JSON.parse(text);
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

  // 4. Event types the code names in the app's own namespace are declared as published.
  const published = new Set((manifest.events?.publishes ?? []).map((e) => e.type));
  const subscribed = manifest.events?.subscribes ?? [];
  const undeclared = new Map<string, string>(); // type → first file naming it
  for (const f of files) {
    for (const type of eventTypesIn(f.text, app)) {
      if (!published.has(type) && !subscribed.some((s) => s.type === type) && !undeclared.has(type)) {
        undeclared.set(type, f.rel);
      }
    }
  }
  for (const [type, file] of [...undeclared].sort(([a], [b]) => a.localeCompare(b))) {
    findings.push({
      app,
      kind: "event-not-declared",
      subject: type,
      file: rel(path.join(appDir, file)),
      message: `the code names event ${type}, but the manifest doesn't publish it (add it to events.publishes with a schema)`,
    });
  }

  // 5. Every subscription has a handler: a route file serving its path, or code that names the type.
  const routeRes = files.map((f) => routeUrl(f.rel)).flatMap((u) => (u === undefined ? [] : [routeUrlRegex(u)]));
  for (const sub of subscribed) {
    const served = routeRes.some((re) => re.test(sub.handler));
    const named = files.some((f) => mentionsKey(f.text, sub.type));
    if (!served && !named) {
      findings.push({
        app,
        kind: "event-handler-missing",
        subject: sub.type,
        message: `the app subscribes to ${sub.type}, but no route file serves its handler ${sub.handler} and no code names the type`,
      });
    }
  }

  // 6. Permissions the code checks in the app's own namespace are declared (as a permission or a role).
  const declared = new Set([...keys, ...manifest.roles.map((r) => r.key)]);
  const unknownKeys = new Map<string, string>(); // key → first file checking it
  for (const f of files) {
    for (const key of checkedKeysIn(f.text, app)) {
      if (!declared.has(key) && !unknownKeys.has(key)) unknownKeys.set(key, f.rel);
    }
  }
  for (const [key, file] of [...unknownKeys].sort(([a], [b]) => a.localeCompare(b))) {
    findings.push({
      app,
      kind: "permission-not-declared",
      subject: key,
      file: rel(path.join(appDir, file)),
      message: `the code checks permission ${key}, but the manifest doesn't declare it, so nobody can be granted it and the check always refuses (a typo, or add it to permissions)`,
    });
  }

  // 7. Every declared secret is read somewhere in the app's code (framework-read names aside).
  for (const name of [...(manifest.secrets ?? [])].sort()) {
    if (FRAMEWORK_SECRET.test(name)) continue;
    if (!files.some((f) => mentionsName(f.text, name))) {
      findings.push({
        app,
        kind: "secret-never-read",
        subject: name,
        message: `secret ${name} is declared, so its value is handed to the app's containers, but no code reads it (remove it, or fix the name the code reads)`,
      });
    }
  }

  // 8. The health paths are served: a route file whose URL matches the path and that exports GET.
  const healthPaths = [...new Set([manifest.runtime.health.live, manifest.runtime.health.ready])];
  for (const healthPath of healthPaths) {
    // Next.js serves a path from the most specific matching route (static before dynamic), so only that
    // file's exports decide; a commented-out `GET` doesn't count.
    const serving = files
      .flatMap((f) => {
        const url = routeUrl(f.rel);
        return url !== undefined && routeUrlRegex(url).test(healthPath) ? [{ ...f, url }] : [];
      })
      .sort((a, b) => compareRouteSpecificity(a.url, b.url));
    if (serving[0] && exportedMethods(stripComments(serving[0].text)).includes("GET")) continue;
    const probes = [
      manifest.runtime.health.live === healthPath ? "live" : undefined,
      manifest.runtime.health.ready === healthPath ? "ready" : undefined,
    ].filter(Boolean);
    const which = `runtime.health.${probes.join(" and runtime.health.")} ${probes.length > 1 ? "are" : "is"}`;
    findings.push({
      app,
      kind: "health-route-missing",
      subject: healthPath,
      ...(serving[0] ? { file: rel(path.join(appDir, serving[0].rel)) } : {}),
      message: serving[0]
        ? `${which} ${healthPath}, but its route file doesn't export GET, so core-api's health poll gets a 405 and the app never reads as healthy`
        : `${which} ${healthPath}, but no route file serves it, so core-api's health poll gets a 404 and the app never reads as healthy (fix the path, or add app${healthPath}/route.ts)`,
    });
  }

  // 9. Config keys the code reads are declared, with a type the getter accepts (the SDK throws otherwise).
  const configTypes = new Map((manifest.config ?? []).map((c) => [c.key, c.type as string]));
  const badReads = new Map<string, { kind: FindingKind; file: string; message: string }>(); // key → first
  for (const f of files) {
    for (const { getter, key } of configReadsIn(f.text)) {
      if (badReads.has(key)) continue;
      const type = configTypes.get(key);
      const accepted = CONFIG_GETTERS[getter]!;
      if (type === undefined) {
        badReads.set(key, {
          kind: "config-not-declared",
          file: f.rel,
          message: `the code reads config ${key} with ${getter}, but the manifest's config doesn't declare it, so the SDK throws when that code runs (a typo, or add it to config)`,
        });
      } else if (!accepted.includes(type)) {
        badReads.set(key, {
          kind: "config-type-mismatch",
          file: f.rel,
          message: `the code reads config ${key} with ${getter}, but the manifest declares it as ${type}, so the SDK throws when that code runs (use the getter for ${type}, or change its type)`,
        });
      }
    }
  }
  for (const [key, bad] of [...badReads].sort(([a], [b]) => a.localeCompare(b))) {
    findings.push({ app, kind: bad.kind, subject: key, file: rel(path.join(appDir, bad.file)), message: bad.message });
  }

  // 10. Every declared config key is read somewhere, unless the code reads them all (`config.all()`).
  if (!files.some((f) => readsAllConfig(f.text))) {
    const code = files.map((f) => stripComments(f.text));
    for (const key of [...configTypes.keys()].sort()) {
      if (code.some((t) => mentionsKey(t, key))) continue;
      findings.push({
        app,
        kind: "config-never-read",
        subject: key,
        message: `config ${key} is declared, but no code reads it, so setting it changes nothing (remove it, or fix the key the code reads)`,
      });
    }
  }

  // 11. Every published event type is named somewhere in the code as a whole string literal (comments
  // ignored), so something can publish it. The manifest and the `events/` schemas aren't code (see
  // `sourceFiles`).
  const publishedTypes = [...published].sort();
  if (publishedTypes.length > 0) {
    const literals = files.map((f) => stringLiterals(f.text));
    for (const type of publishedTypes) {
      if (literals.some((l) => l.has(type))) continue;
      findings.push({
        app,
        kind: "event-never-published",
        subject: type,
        message: `the manifest publishes event ${type}, but no code names it, so subscribers wait for an event that never comes (remove it, or fix the type the code publishes)`,
      });
    }
  }

  // 12. Every manifest route with a permission is served: by a route file or a page whose URL overlaps
  // its glob and that answers one of its methods. Otherwise the gateway's check guards nothing.
  const served = files.flatMap((f) => {
    const routeAt = routeUrl(f.rel);
    if (routeAt !== undefined) {
      const methods = new Set(exportedMethods(stripComments(f.text)));
      if (methods.has("GET")) methods.add("HEAD"); // Next.js answers HEAD with GET
      methods.add("OPTIONS"); // and OPTIONS for any route file
      return [{ url: routeAt, file: f.rel, methods }];
    }
    const pageAt = pageUrl(f.rel);
    return pageAt === undefined ? [] : [{ url: pageAt, file: f.rel, methods: new Set(["GET", "HEAD"]) }];
  });
  for (const r of routes) {
    if (r.permission === undefined || r.expose === false) continue;
    const glob = globRegex(r.path);
    const globPaths = globSamples(r.path);
    const matching = served.filter(
      (s) => samplePaths(s.url).some((p) => glob.test(p)) || globPaths.some((p) => routeUrlRegex(s.url).test(p)),
    );
    const methods = r.methods as readonly string[] | undefined;
    if (matching.some((s) => !methods || methods.some((m) => s.methods.has(m)))) continue;
    const subject = methods ? `${methods.join(",")} ${r.path}` : r.path;
    findings.push({
      app,
      kind: "route-not-served",
      subject,
      ...(matching[0] ? { file: rel(path.join(appDir, matching[0].file)) } : {}),
      message: matching[0]
        ? `the manifest guards ${subject} with ${r.permission}, but no file serving it answers ${methods!.join(" or ")}, so the check guards nothing (fix the route's methods, or the handler's)`
        : `the manifest guards ${r.path} with ${r.permission}, but no route file or page serves it, so the check guards nothing (the handler moved? point the route at its new path)`,
    });
  }

  return { app, findings, handlers, plumbing };
}

export interface ReviewOptions {
  ids: string[];
  json: boolean;
  markdown: boolean;
  strict: boolean;
  root?: string;
}

export function parseReviewArgs(args: string[]): ReviewOptions | null {
  const opts: ReviewOptions = { ids: [], json: false, markdown: false, strict: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") opts.json = true;
    else if (a === "--markdown") opts.markdown = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--root" && args[i + 1] && !args[i + 1]!.startsWith("-")) opts.root = args[++i];
    else if (a.startsWith("-")) return null;
    else opts.ids.push(a);
  }
  if (opts.json && opts.markdown) return null; // one output format at a time
  return opts;
}

/** The first line of the Markdown report: CI finds its own earlier comment by it. */
export const MARKDOWN_MARKER = "<!-- asafarim:manifest-review -->";
/** The second line of a report with no findings and no errors: CI posts nothing new for it. */
export const MARKDOWN_CLEAN_MARKER = "<!-- asafarim:manifest-review:clean -->";

/**
 * Text for one Markdown table cell, shown literally: no HTML, no formatting, no line breaks, and a
 * `|` can't end the cell. Findings quote file paths and code, so nothing is trusted.
 */
export function markdownCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/[|`*_~[\]]/g, (c) => `\\${c}`);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The review as a Markdown report for a pull request comment (P7.2 part 2b). Deterministic: apps by id,
 * findings by kind, subject, file and message, so an unchanged review renders byte for byte the same
 * and CI's in-place update is a no-op. The first line is `MARKDOWN_MARKER`; a report with nothing to
 * say has `MARKDOWN_CLEAN_MARKER` second. `errors` are manifests that couldn't be reviewed.
 */
export function renderMarkdown(reviews: AppReview[], errors: string[] = []): string {
  const sorted = [...reviews].sort((a, b) => byText(a.app, b.app));
  const total = sorted.reduce((n, r) => n + r.findings.length, 0);
  const withFindings = sorted.filter((r) => r.findings.length > 0);
  const apps = (n: number) => `${n} app${n === 1 ? "" : "s"}`;
  const out = [MARKDOWN_MARKER];
  if (total === 0 && errors.length === 0) out.push(MARKDOWN_CLEAN_MARKER);
  out.push("## Manifest review", "");
  out.push(
    total === 0
      ? `No findings in ${apps(sorted.length)} reviewed.`
      : `${total} finding${total === 1 ? "" : "s"} across ${apps(withFindings.length)} (of ${sorted.length} reviewed).`,
  );
  out.push(
    "",
    "_Advisory (ADR 0001 §10 item 2): what each app's manifest declares compared with what its code does. It never fails CI; run `pnpm platform manifest review` locally for the same report._",
  );
  if (errors.length > 0) {
    out.push("", "### Not reviewed", "");
    for (const e of [...errors].sort(byText)) out.push(`- ${markdownCell(e)}`);
  }
  for (const r of withFindings) {
    const rows = r.findings
      .map((f) => [f.kind, f.subject, f.file ?? "", f.message].map(markdownCell))
      .sort((a, b) => {
        for (let i = 0; i < a.length; i++) {
          const c = byText(a[i]!, b[i]!);
          if (c !== 0) return c;
        }
        return 0;
      });
    out.push("", `### ${markdownCell(r.app)}`, "", "| kind | subject | file | message |", "| --- | --- | --- | --- |");
    for (const row of rows) out.push(`| ${row.join(" | ")} |`);
  }
  return out.join("\n");
}

export interface ReviewResult {
  ok: boolean;
  lines: string[];
  /** Print `lines` to stdout even when not ok: the Markdown report is wanted either way. */
  stdout?: boolean;
}

/** Review the named apps under `<root>/apps/`, or all of them. */
export function reviewCommand(args: string[], cwd: string, findRoot: () => string): ReviewResult | null {
  const opts = parseReviewArgs(args);
  if (!opts) return null;
  const root = opts.root ? path.resolve(cwd, opts.root) : findRoot();
  const appsDir = path.join(root, "apps");
  // Each app's manifest text, read once (an app is a folder with a readable platform.app.json).
  const manifests = new Map<string, string>();
  let entries: string[] = [];
  try {
    entries = readdirSync(appsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    entries = []; // no apps/ folder
  }
  for (const name of entries) {
    try {
      manifests.set(name, readFileSync(path.join(appsDir, name, MANIFEST_FILE), "utf8"));
    } catch {
      // not an app folder
    }
  }
  const ids = opts.ids.length > 0 ? opts.ids : [...manifests.keys()];
  const unknown = ids.filter((id) => !manifests.has(id));
  if (unknown.length > 0) {
    return { ok: false, lines: [`✖ no apps/<id>/${MANIFEST_FILE} for: ${unknown.join(", ")}`] };
  }

  const reviews: AppReview[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    let value: unknown;
    try {
      value = JSON.parse(manifests.get(id)!);
    } catch (error) {
      errors.push(`✖ apps/${id}/${MANIFEST_FILE}: not JSON (${(error as Error).message})`);
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
  if (opts.markdown) {
    // The report goes to stdout whatever the outcome, so CI can post it; the exit code still tells.
    return { ok, lines: [renderMarkdown(reviews, errors)], stdout: true };
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
