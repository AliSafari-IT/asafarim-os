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
 * - `event-schema-uncompilable`: a published event's schema file is a JSON object that doesn't compile
 *   with the publisher's own ajv setup (`compileEventSchema` from `@asafarim/events`: JSON Schema
 *   2020-12, strict, ajv-formats), e.g. an unknown keyword or `format`, or a `$ref` that resolves to
 *   nothing. `createPublisher` then throws when the app starts, and core-api refuses the app's whole
 *   schema upload (`invalid_event_schemas`). The schema is compiled as data; no app code runs.
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
 * - `event-schema-unused`: a `.json` file at the top of the app's `events/` folder that no
 *   `events.publishes[].schema` points to. It is usually left behind by a renamed or removed event
 *   type, and reads as a contract the app no longer publishes.
 * - `permission-not-granted`: a declared permission that no role in the manifest grants, neither by
 *   name nor through `<id>.*`. core-api gives permissions only through roles, so nobody can hold it
 *   and every check on it refuses. It is usually a permission added without updating `roles`.
 * - `nav-target-missing`: a `ui.nav[].href` that no page (`app/**\/page.tsx`) serves and no route file
 *   answers with `GET` (the most specific match decides, as Next.js picks it). Launchers and the app's
 *   own navigation show the link, and it answers 404 (or 405), usually because the page moved.
 * - `public-path-not-served`: an `auth.publicPaths` glob that no route file, page or file in `public/`
 *   serves (overlap by the same rule as `route-not-served`). Nothing answers there today, but any
 *   handler added at that path later is public without anyone deciding it. It is usually left behind
 *   when a public page or health route moves.
 * - `launcher-not-public`: an active app whose launcher tile says anyone may open it
 *   (`ui.launcher.access: "public"`) while it signs users in (`auth.client: "oidc"`) and no
 *   `auth.publicPaths` glob covers `/`, the page the tile opens. The manifest contradicts itself: a
 *   signed-out visitor is sent to sign-in. Make `/` public, or set the tile to `"authenticated"`
 *   (with `requiresAccountToUse` for a site whose other pages are public).
 * - `public-path-guarded`: an `auth.publicPaths` glob where every path it covers is behind a manifest
 *   route with a `permission` for every method (no `methods` limit, not `expose: false`). core-api's
 *   gateway doesn't read `publicPaths`, so it still asks for the permission there, and a signed-out
 *   visitor gets 401 or sign-in. The manifest contradicts itself. Partial overlaps (`/**` public with
 *   guarded API routes, `/orders/*` public with only `/orders/1` guarded) are a valid design and aren't
 *   reported, nor is a path a route hides (`expose: false`) for every method.
 * - `subscription-not-published`: an `events.subscribes[].type` whose namespace names an app in this
 *   repo (a valid `apps/<app>/platform.app.json`, the reviewed app included), when that app's
 *   `events.publishes` doesn't list the type. The subscriber waits for an event that never comes
 *   (core-api shows it as waiting for its publisher), usually after a version bump or a rename on the
 *   publisher's side. When the publisher has the same type at another version, the message names it.
 *   Publishers outside this repo and `core.*` types aren't checked. It reads every app's manifest,
 *   also when only some ids are reviewed.
 * - `route-hidden`: a manifest route with a `permission` where every path and method it covers is also
 *   matched by `expose: false` routes (hidden routes limited to different methods may cover it
 *   together; a guarded route without `methods` answers every method). core-api's gateway answers 404
 *   for a hidden path before it asks for any permission, so the guarded route is dead and its handler
 *   can't be reached through the gateway, usually because it was declared under a hidden prefix such
 *   as `/internal/**`. Partial overlaps aren't reported. Coverage is proved the same way as for
 *   `public-path-guarded`.
 * - `nav-target-hidden`: a `ui.nav[].href` that an `expose: false` manifest route matches for `GET`
 *   (no `methods` limit, or `methods` including `GET`). core-api's gateway answers 404 for a hidden
 *   path, so the link is dead even when a page serves it, usually because the page sits under a hidden
 *   prefix such as `/internal/**`. A trailing slash is dropped, as the gateway does.
 * - `public-path-hidden`: an `auth.publicPaths` glob where every path it covers is hidden
 *   (`expose: false`) for every method (hidden routes limited to different methods may cover it
 *   together). The manifest promises a public path, and core-api's gateway answers 404 there for
 *   everyone, usually because the path sits under a hidden prefix such as `/internal/**`. Partial
 *   overlaps aren't reported; coverage is proved the same way as for `route-hidden`. A glob that covers
 *   `runtime.health.live` or `.ready` is skipped: the health poller calls the app directly, so hiding
 *   health from the internet while the app lets it through without sign-in is a valid design.
 * - `launcher-target-hidden`: an active app with a launcher tile (`ui.launcher`) where an
 *   `expose: false` manifest route matches `/` for `GET` (no `methods` limit, or `methods` including
 *   `GET`). The tile opens the app's start page (`https://<primary>/`), and core-api's gateway answers
 *   404 for a hidden path, so the tile is dead for everyone who opens it, usually because a hiding glob
 *   such as `/**` was meant for a narrower prefix. Coming-soon apps and apps without a tile are skipped.
 * - `launcher-target-missing`: an active app with a launcher tile (`ui.launcher`) where no page
 *   (`app/**\/page.tsx`) serves `/` and no route file answers it with `GET` (the most specific match
 *   decides, as for `nav-target-missing`). The tile opens the app's start page, so it answers 404 (or
 *   405) to everyone who opens it, usually because the start page moved under a route group or a
 *   prefix. Coming-soon apps, apps without a tile, and apps whose `ui.nav` already links `/` (reported
 *   as `nav-target-missing`) are skipped. Redirects in `next.config` or middleware aren't read.
 * - `launcher-target-guarded`: an active app with a launcher tile (`ui.launcher`) where a manifest
 *   route that isn't hidden puts a `permission` on `/` for `GET` (no `methods` limit, or `methods`
 *   including `GET`). core-api's gateway asks for the permissions of every route matching a path, so it
 *   asks for this one when someone opens the tile: with `access: "public"` a signed-out visitor is sent
 *   to sign-in, and with either access a signed-in user without the permission gets 403. The tile
 *   promises more than the gateway allows, usually because a guarding glob such as `/**` was meant for
 *   a narrower prefix. Coming-soon apps, apps without a tile, and apps where `/` is hidden (reported as
 *   `launcher-target-hidden`) are skipped.
 * - `database-not-declared`: the manifest says `database.engine: "none"`, but the app's runtime code
 *   names `DATABASE_URL` as a whole word (comments ignored, e.g. `process.env.DATABASE_URL`), and
 *   `DATABASE_URL` isn't a declared secret. The platform provisions a database and hands the app
 *   `DATABASE_URL` only for `engine: "postgres"` (`platform app install`, compose, core-api), so the
 *   read gets `undefined` and the code that needs the database fails at runtime. Usually the manifest
 *   was scaffolded without a database and the code added one later. An app that brings its own
 *   database lists `DATABASE_URL` in `secrets` and isn't reported.
 * - `database-never-read`: the mirror case. The manifest says `database.engine: "postgres"`, but no
 *   runtime code names `DATABASE_URL` as a whole word (comments ignored), and no Prisma schema in the
 *   app (`*.prisma`, e.g. `url = env("DATABASE_URL")`) names it either. The platform provisions the
 *   database, runs its migrations and hands the app `DATABASE_URL`, and nothing reads it. Usually the
 *   code reads the URL under another name (and gets `undefined`), or the code stopped using the
 *   database and the manifest kept it.
 * - `database-migrations-missing`: the manifest says `database.engine: "postgres"` with
 *   `migrations: "prisma"` or `"drizzle"`, but the app has nothing for that tool's migrator command
 *   (`prisma migrate deploy`, `drizzle-kit migrate`; `MIGRATE_COMMANDS` in `compose.ts`) to run: no
 *   `*.prisma` schema anywhere in the app's source, or no `drizzle.config.*` at the app's root. The
 *   command then fails, so installing the app stops at its migrations. Usually the manifest names the
 *   wrong tool, or the schema or config sits outside the app folder. `migrations: "sql"` has no
 *   standard command and isn't checked.
 * - `worker-name-reserved`: a `runtime.workers[].name` is `web` or `migrate`. The manifest schema
 *   accepts it, but those are the compose file's web service and migrator (`RESERVED_SERVICE_NAMES`
 *   in `compose.ts`), so `platform compose` refuses to write the app's file and the app can't be
 *   deployed until the worker is renamed. One finding per such worker.
 * - `secret-name-reserved`: `database.engine` is `"postgres"` and a declared secret is named
 *   `DATABASE_URL`, `<ID>_DATABASE_URL` or `<ID>_MIGRATOR_DATABASE_URL`, the database variables the
 *   compose file generates (`databaseVariableNames` in `compose.ts`). The manifest schema accepts it,
 *   but `platform compose` refuses to write the app's file, so the app can't be deployed until the
 *   secret is renamed or dropped. One finding per such secret. With `engine: "none"` the app may bring
 *   its own `DATABASE_URL` as a secret, and nothing is reported.
 * - `runtime-port-mismatch`: the app's root `Dockerfile` sets `ENV PORT` to a number other than
 *   `runtime.port` in its final stage (or in the earlier stage that one is built `FROM`). The gateway
 *   and the compose file reach the web service on `runtime.port`, but the server listens on `PORT`, so
 *   every request through the gateway fails. Only a literal number counts: an `ARG` or `${…}` value, or
 *   no root `Dockerfile`, is not checked. `EXPOSE` is documentation and isn't read.
 * - `domain-claimed-twice`: a host the app claims (`domains.primary`, or `<id>.asafarim.site` when there
 *   is none, and each `domains.aliases` entry, read as `platform against`'s drift check reads them) is
 *   also claimed by another app in this repo (a valid `apps/<app>/platform.app.json`). The manifest
 *   schema checks one manifest at a time, but the gateway sends a host to one app only, so the other
 *   is unreachable at that host (a launcher tile opening it lands on the wrong app). Usually a copied
 *   manifest kept the other app's domain. It is reported on each app that claims the host, naming the
 *   others. Apps are told apart by folder, so a manifest copied to a second folder with its id unchanged
 *   counts too. It reads every app's manifest, also when only some ids are reviewed.
 * - `config-variable-clash`: two of the manifest's names share one environment variable. The app SDK
 *   reads each `config` key from `APP_CONFIG_<KEY>`, with dots and camelCase as UPPER_SNAKE
 *   (`envNameForConfigKey` in `@asafarim/app-manifest`), and the manifest schema only rejects duplicate
 *   keys. So two different keys can read the same variable (`limits.maxNotes` and `limitsMax.notes`
 *   both read `APP_CONFIG_LIMITS_MAX_NOTES`): setting one sets the other, and they can't differ. And a
 *   declared secret can have the name a config key reads, so the secret's value is read as that config
 *   value (and one that isn't of the key's type makes the app throw when it starts). One finding per
 *   shared variable, naming every key and secret that uses it.
 * - `route-permissions-stacked`: two or more manifest routes with a `permission` (not `expose: false`)
 *   match the same path for the same method, with different permissions, and no role in the manifest
 *   grants all of them (by name or through `<id>.*`). core-api's gateway asks for the permission of
 *   every route matching a request, so the overlap needs them all, and a user holding only the role
 *   meant for that path gets 403 there. It is usually a narrower route (`/api/admin/**` with
 *   `<id>.admin`) meant to replace a broader one's permission (`/api/**` with `<id>.read`), which the
 *   gateway doesn't do. Paths an `expose: false` route hides for that method are skipped (the gateway
 *   answers 404 there first). Overlap is found on sample paths of the routes' globs and of the app's
 *   route files and pages, as for `public-path-not-served`. One finding per set of routes.
 *
 * Output: text lines by default; `--json` prints `{ reviews, errors }`; `--markdown` (P7.2 part 2b)
 * prints the report CI posts as one advisory pull request comment, updated in place (see
 * `renderMarkdown`). The two are mutually exclusive. Exit codes don't depend on the format.
 *
 * Sign-in plumbing is not a finding: Auth.js's own endpoints under `/api/auth/` and the SDK's session
 * hand-off (`createSessionHandler`).
 *
 * A route's `methods` limit is read the way core-api's gateway reads it (`methodCovered`): no limit
 * covers every method, and `GET` also covers `HEAD`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  HTTP_METHODS,
  defaultHost,
  envNameForConfigKey,
  validateManifest,
  type AppManifest,
} from "@asafarim/app-manifest";
import { compileEventSchema } from "@asafarim/events";
import { RESERVED_SERVICE_NAMES, databaseVariableNames } from "./compose.ts";
import { MANIFEST_FILE } from "./sync.ts";

/** Every finding kind `review` reports, in the order the header above describes them. The README table lists each one. */
export const FINDING_KINDS = [
  "event-schema-missing",
  "event-schema-invalid",
  "event-schema-uncompilable",
  "permission-never-checked",
  "route-unguarded",
  "event-not-declared",
  "event-handler-missing",
  "permission-not-declared",
  "secret-never-read",
  "health-route-missing",
  "config-not-declared",
  "config-type-mismatch",
  "config-never-read",
  "event-never-published",
  "route-not-served",
  "event-schema-unused",
  "permission-not-granted",
  "nav-target-missing",
  "public-path-not-served",
  "launcher-not-public",
  "public-path-guarded",
  "subscription-not-published",
  "route-hidden",
  "nav-target-hidden",
  "public-path-hidden",
  "launcher-target-hidden",
  "launcher-target-missing",
  "launcher-target-guarded",
  "database-not-declared",
  "database-never-read",
  "database-migrations-missing",
  "worker-name-reserved",
  "secret-name-reserved",
  "runtime-port-mismatch",
  "domain-claimed-twice",
  "config-variable-clash",
  "route-permissions-stacked",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

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
/** Prisma schema files: `prisma/schema.prisma`, or the multi-file `prisma/schema/*.prisma`. */
const PRISMA_FILE = /\.prisma$/;
/** drizzle-kit's default config file, which `drizzle-kit migrate` reads from the app's root. */
const DRIZZLE_CONFIG = /^drizzle\.config\.(?:ts|js|mjs|cjs|mts|cts|json)$/;

/**
 * Splits `KEY=VALUE KEY2="VALUE 2"` the way a Dockerfile's `ENV` does: whitespace separates words unless it is
 * quoted or escaped with `\`, and quotes and escapes are removed from the result.
 */
function dockerWords(text: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === undefined && /\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    word ??= "";
    if (c === "\\" && quote !== "'" && i + 1 < text.length) word += text[++i];
    else if (quote === undefined && (c === '"' || c === "'")) quote = c;
    else if (c === quote) quote = undefined;
    else word += c;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * The `PORT` value a Dockerfile's final image runs with: the last `ENV PORT`
 * of the final stage, or of the earlier stage it is built `FROM` (an image inherits its base's `ENV`).
 * Returns the raw value; `undefined` when no stage in that chain sets it.
 */
export function dockerfilePort(text: string): string | undefined {
  const stages: { base: string; alias?: string; port?: string }[] = [];
  // Docker drops comment lines before it joins `\` continuations, so a comment can sit inside an instruction.
  const lines = text
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\[ \t]*\r?\n/g, " ")
    .split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const [instruction = "", ...rest] = line.split(/\s+/);
    const args = rest.filter((a) => !a.startsWith("--")); // FROM --platform=…
    if (/^from$/i.test(instruction)) {
      const alias = /^as$/i.test(args[1] ?? "") ? args[2]?.toLowerCase() : undefined;
      stages.push({ base: (args[0] ?? "").toLowerCase(), alias });
      continue;
    }
    const stage = stages.at(-1);
    if (!stage || !/^env$/i.test(instruction)) continue;
    const body = line.slice(instruction.length).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(body)) {
      for (const word of dockerWords(body)) if (word.startsWith("PORT=")) stage.port = word.slice("PORT=".length);
    } else {
      const legacy = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(body);
      if (legacy?.[1] === "PORT") stage.port = legacy[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  // Walk back through the bases: each step goes to an earlier stage, so this ends.
  for (let i = stages.length - 1; i >= 0;) {
    const stage = stages[i]!;
    if (stage.port !== undefined) return stage.port;
    i = stages.findLastIndex((s, j) => j < i && s.alias !== undefined && s.alias === stage.base);
  }
  return undefined;
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MANIFEST_SOURCE = /^platform\.app\.(?:ts|js|mjs|json)$/;
const ROUTE_FILE = /^route\.[cm]?[jt]sx?$/;
const PAGE_FILE = /^page\.[cm]?[jt]sx?$/;

/**
 * The app's runtime source files (no tests, no manifest), relative to `appDir`, sorted. `fileName`
 * picks other files under the same folder rules (`PRISMA_FILE`).
 */
export function sourceFiles(appDir: string, fileName: RegExp = SOURCE_FILE): string[] {
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
        fileName.test(entry.name) &&
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
 * or more, `[[...x]]` → none or more (`/[[...x]]` answers `/` too).
 */
export function routeUrlRegex(url: string): RegExp {
  let re = "";
  for (const seg of url.split("/").filter(Boolean)) {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) re += "(?:/[^/]+)*";
    else if (/^\[\.\.\.[^\]]+\]$/.test(seg)) re += "(?:/[^/]+)+";
    else if (/^\[[^\]]+\]$/.test(seg)) re += "/[^/]+";
    else re += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  }
  // An optional catch-all at the top (`/[[...x]]`) also answers `/` itself, the way Next.js serves it.
  if (re === "") return /^\/$/;
  return new RegExp(new RegExp(`^${re}$`).test("") ? `^(?:${re}|/)$` : `^${re}$`);
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

/**
 * Whether a manifest route's `methods` limit covers a method, the way core-api's gateway reads it
 * (`methodCovered` in `core/core-api/src/gateway.ts`): no limit covers every method, and a route that
 * lists `GET` also covers `HEAD`, since Next.js answers `HEAD` by running the `GET` handler.
 */
export function methodCovered(methods: readonly string[] | undefined, method: string): boolean {
  if (!methods) return true;
  return methods.includes(method) || (method === "HEAD" && methods.includes("GET"));
}

/** The HTTP methods a route file exports (`export function GET`, `export const POST = …`, `export { GET }`). */
export function exportedMethods(text: string): string[] {
  const found = new Set<string>();
  for (const m of HTTP_METHODS) {
    const decl = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${m}\\b`);
    if (decl.test(text)) found.add(m);
  }
  // `export { GET, handler as POST }`: the exported names in each export list (after `as`, if any).
  for (const list of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of list[1]!.split(",")) {
      const name = item.trim().split(/\s+/).at(-1);
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

/**
 * What each app in the repo publishes, by app id, for checks that look across apps
 * (`subscription-not-published`). Only apps with a valid manifest are in it.
 */
export type Publishers = ReadonlyMap<string, readonly string[]>;

/**
 * Which apps in the repo claim each host, by host (`domain-claimed-twice`): each claimant's folder under
 * `apps/` and its manifest id. Only apps with a valid manifest are in it.
 */
export type HostClaims = ReadonlyMap<string, readonly { folder: string; id: string }[]>;

export function claimedHosts(manifest: AppManifest): string[] {
  return [...new Set([manifest.domains?.primary ?? defaultHost(manifest.id), ...(manifest.domains?.aliases ?? [])])];
}

/**
 * Every valid manifest's hosts, by host, with the apps that claim it in the order given. Claimants are
 * told apart by folder, so a manifest copied to a second folder without a new id still counts twice.
 */
export function hostClaims(apps: Iterable<{ folder: string; manifest: AppManifest }>): HostClaims {
  const claims = new Map<string, { folder: string; id: string }[]>();
  for (const { folder, manifest } of apps) {
    for (const host of claimedHosts(manifest)) {
      const list = claims.get(host) ?? [];
      list.push({ folder, id: manifest.id });
      claims.set(host, list);
    }
  }
  return claims;
}

/** An event type without its trailing `.v<N>`, so two versions of one type compare equal. */
export function unversioned(type: string): string {
  return type.replace(/\.v\d+$/, "");
}

/**
 * Review one app folder. `rootDir` is only used to print file paths relative to the workspace;
 * `publishers` is what the repo's apps publish (the reviewed app's own manifest always counts);
 * `hosts` is which apps claim each host (the reviewed app's own claims are taken from its manifest, and
 * it is told apart from the others by its folder, `appDir`'s name).
 */
export function reviewApp(
  appDir: string,
  manifest: AppManifest,
  rootDir: string,
  publishers: Publishers = new Map(),
  hosts: HostClaims = new Map(),
): AppReview {
  const app = manifest.id;
  const rel = (abs: string) => path.relative(rootDir, abs).split(path.sep).join("/");
  const findings: Finding[] = [];

  // 1. Published event types have a schema file that is a JSON object and compiles as the publisher compiles it.
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
      continue;
    }
    try {
      compileEventSchema(parsed);
    } catch (error) {
      findings.push({
        app,
        kind: "event-schema-uncompilable",
        subject: ev.type,
        file: rel(file),
        message: `the schema of ${ev.type} doesn't compile (${(error as Error).message}), so the app's publisher throws when it starts and core-api refuses its schema upload`,
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
              methodCovered(r.methods, method) &&
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
    // The concrete paths the route covers, from both sides; for each, Next.js serves it from the most
    // specific matching file only (static before dynamic before catch-all), so only that file's methods count.
    const covered = new Set([...globPaths, ...served.flatMap((s) => samplePaths(s.url).filter((p) => glob.test(p)))]);
    const matching = [
      ...new Set(
        [...covered].flatMap((p) => {
          const winner = served
            .filter((s) => routeUrlRegex(s.url).test(p))
            .sort((a, b) => compareRouteSpecificity(a.url, b.url))[0];
          return winner ? [winner] : [];
        }),
      ),
    ];
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

  // 13. Every schema file at the top of the app's `events/` folder belongs to a published event type.
  const schemaFiles = new Set((manifest.events?.publishes ?? []).map((ev) => path.resolve(appDir, ev.schema)));
  let eventFiles: string[] = [];
  try {
    eventFiles = readdirSync(path.join(appDir, "events"), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => d.name)
      .sort();
  } catch {
    eventFiles = []; // no events/ folder (or not a folder)
  }
  for (const name of eventFiles) {
    const file = path.resolve(appDir, "events", name);
    if (schemaFiles.has(file)) continue;
    findings.push({
      app,
      kind: "event-schema-unused",
      subject: `events/${name}`,
      file: rel(file),
      message: `events/${name} is an event schema no published event in the manifest points to, so it describes a contract the app doesn't publish (remove it, or point the event's schema at it)`,
    });
  }

  // 14. Every declared permission is granted by some role (by name or through `<id>.*`).
  const granted = new Set((manifest.roles ?? []).flatMap((r) => r.grants));
  if (!granted.has(`${app}.*`)) {
    for (const key of keys) {
      if (granted.has(key)) continue;
      findings.push({
        app,
        kind: "permission-not-granted",
        subject: key,
        message: `permission ${key} is declared but no role grants it, so nobody can hold it and every check on it refuses (add it to a role's grants)`,
      });
    }
  }

  // 15. Every nav link is served: by a page, or a route file that exports GET. Next.js serves a path
  // from the most specific matching file only (static before dynamic before catch-all).
  const navServed = files.flatMap((f) => {
    const routeAt = routeUrl(f.rel);
    if (routeAt !== undefined)
      return [{ url: routeAt, file: f.rel, get: exportedMethods(stripComments(f.text)).includes("GET") }];
    const pageAt = pageUrl(f.rel);
    return pageAt === undefined ? [] : [{ url: pageAt, file: f.rel, get: true }];
  });
  for (const href of [...new Set(manifest.ui.nav.map((n) => n.href))]) {
    const target = href.replace(/\/+$/, "") || "/"; // Next.js drops a trailing slash
    const winner = navServed
      .filter((s) => routeUrlRegex(s.url).test(target))
      .sort((a, b) => compareRouteSpecificity(a.url, b.url))[0];
    if (winner?.get) continue;
    const labels = manifest.ui.nav.filter((n) => n.href === href).map((n) => `"${n.label}"`);
    findings.push({
      app,
      kind: "nav-target-missing",
      subject: href,
      ...(winner ? { file: rel(path.join(appDir, winner.file)) } : {}),
      message: winner
        ? `the nav link ${labels.join(", ")} points to ${href}, but the route file serving it doesn't export GET, so the link answers 405 (export GET, or fix the href)`
        : `the nav link ${labels.join(", ")} points to ${href}, but no page or route file serves it, so the link answers 404 (the page moved? fix the href)`,
    });
  }

  // 16. Every public path is served: by a route file, a page, or a static file in `public/`. A stale
  // entry makes whatever is added there later public without anyone deciding it.
  const publicServed = files.flatMap((f) => {
    const url = routeUrl(f.rel) ?? pageUrl(f.rel);
    return url === undefined ? [] : [url];
  });
  // Static files are served at their literal path: a `[x]` in a file name is not a dynamic segment.
  const publicStatic = staticFiles(path.join(appDir, "public"));
  for (const glob of [...new Set(manifest.auth.publicPaths)]) {
    const re = globRegex(glob);
    const samples = globSamples(glob);
    const overlaps =
      publicStatic.some((url) => re.test(url)) ||
      publicServed.some(
        (url) => samplePaths(url).some((p) => re.test(p)) || samples.some((p) => routeUrlRegex(url).test(p)),
      );
    if (overlaps) continue;
    findings.push({
      app,
      kind: "public-path-not-served",
      subject: glob,
      message: `auth.publicPaths lists ${glob}, but no route file, page or public/ file serves it, so anything added there later is public without anyone deciding it (remove it, or point it at the path that moved)`,
    });
  }

  // 17. A launcher tile open to everyone needs a public start page: the tile opens `/`.
  const launcher = manifest.ui.launcher;
  if (
    launcher?.access === "public" &&
    manifest.ui.status === "active" &&
    manifest.auth.client === "oidc" &&
    !manifest.auth.publicPaths.some((glob) => globRegex(glob).test("/"))
  ) {
    findings.push({
      app,
      kind: "launcher-not-public",
      subject: "ui.launcher.access",
      message: `the launcher tile says anyone may open ${app} (access "public"), but no auth.publicPaths entry covers /, so a signed-out visitor is sent to sign-in (add "/" to auth.publicPaths, or set access to "authenticated")`,
    });
  }

  // 18. A public path is reachable without sign-in: not every path it covers may need a permission at
  // the gateway, which doesn't read `publicPaths`. Only a glob the guarded routes provably cover counts
  // (see `coverSamples`); a route hidden for every method answers 404 there instead.
  const guards = routes.filter((r) => r.expose !== false && r.permission !== undefined && !r.methods);
  const hiders = routes.filter((r) => r.expose === false && !r.methods).map((r) => globRegex(r.path));
  for (const glob of [...new Set(manifest.auth.publicPaths)]) {
    const by = new Set<string>();
    const guarded = coverSamples(glob).every(({ path: p, deep }) => {
      if (hiders.some((re) => re.test(p))) return false;
      const hit = guards.filter((r) => (!deep || r.path.includes("/**")) && globRegex(r.path).test(p));
      for (const r of hit) by.add(r.permission!);
      return hit.length > 0;
    });
    if (!guarded) continue;
    const perms = [...by].sort();
    findings.push({
      app,
      kind: "public-path-guarded",
      subject: glob,
      message: `auth.publicPaths lists ${glob}, but manifest routes put ${perms.length === 1 ? `the permission ${perms[0]}` : `a permission (${perms.join(", ")})`} on every path it covers, and the gateway asks for it whatever publicPaths says, so a signed-out visitor gets 401 or sign-in (remove the entry, or take the permission off the route)`,
    });
  }

  // 19. A guarded route that a hidden route covers for every path and method it names is dead: the
  // gateway answers 404 for a hidden path before it asks for a permission.
  for (const r of routes) {
    if (r.permission === undefined || r.expose === false) continue;
    const methods = r.methods as readonly string[] | undefined;
    const hiding = routes.filter((h) => h.expose === false);
    if (hiding.length === 0) continue;
    // Every method the route answers (all of them without a `methods` limit) must be hidden on every
    // path it covers; hidden routes limited to different methods may share the work.
    const asked: readonly string[] = methods ?? HTTP_METHODS;
    const by = new Set<string>();
    const hidden = coverSamples(r.path).every(({ path: p, deep }) =>
      asked.every((m) => {
        const hit = hiding.filter(
          (h) => methodCovered(h.methods, m) && (!deep || h.path.includes("/**")) && globRegex(h.path).test(p),
        );
        for (const h of hit) by.add(h.path);
        return hit.length > 0;
      }),
    );
    if (!hidden) continue;
    const subject = methods ? `${methods.join(",")} ${r.path}` : r.path;
    findings.push({
      app,
      kind: "route-hidden",
      subject,
      message: `the manifest guards ${subject} with ${r.permission}, but ${[...by].sort().join(" and ")} ${by.size === 1 ? "hides" : "hide"} it (expose: false), and the gateway answers 404 there before it asks for any permission, so the route can't be reached (move it out of the hidden path, or drop it)`,
    });
  }

  // 20. A nav link the gateway hides: it answers 404 for an `expose: false` path before the app sees it.
  const getHiders = routes.filter(
    (h) => h.expose === false && (!h.methods || (h.methods as readonly string[]).includes("GET")),
  );
  for (const href of [...new Set(manifest.ui.nav.map((n) => n.href))]) {
    const target = href.replace(/\/+$/, "") || "/";
    const by = getHiders.filter((h) => globRegex(h.path).test(target)).map((h) => h.path);
    if (by.length === 0) continue;
    const labels = manifest.ui.nav.filter((n) => n.href === href).map((n) => `"${n.label}"`);
    const hiders = [...new Set(by)].sort();
    findings.push({
      app,
      kind: "nav-target-hidden",
      subject: href,
      message: `the nav link ${labels.join(", ")} points to ${href}, but ${hiders.join(" and ")} ${hiders.length === 1 ? "hides" : "hide"} it (expose: false), so the gateway answers 404 there whatever serves it (move the page out of the hidden path, or fix the href)`,
    });
  }

  // 21. A public path the gateway hides for every method: nobody can reach it, signed in or not.
  const allHiders = routes.filter((h) => h.expose === false);
  const health = [manifest.runtime.health.live, manifest.runtime.health.ready];
  for (const glob of allHiders.length === 0 ? [] : [...new Set(manifest.auth.publicPaths)]) {
    const re = globRegex(glob);
    if (health.some((h) => re.test(h))) continue;
    const by = new Set<string>();
    const hidden = coverSamples(glob).every(({ path: p, deep }) =>
      HTTP_METHODS.every((m) => {
        const hit = allHiders.filter(
          (h) => methodCovered(h.methods, m) && (!deep || h.path.includes("/**")) && globRegex(h.path).test(p),
        );
        for (const h of hit) by.add(h.path);
        return hit.length > 0;
      }),
    );
    if (!hidden) continue;
    const hiders = [...by].sort();
    findings.push({
      app,
      kind: "public-path-hidden",
      subject: glob,
      message: `auth.publicPaths lists ${glob}, but ${hiders.join(" and ")} ${hiders.length === 1 ? "hides" : "hide"} every path it covers (expose: false), so the gateway answers 404 there for everyone (remove the entry, or move the public path out of the hidden one)`,
    });
  }

  // 22. A launcher tile the gateway hides: the tile opens `/`, and a hidden path answers 404 there.
  if (launcher && manifest.ui.status === "active") {
    const by = routes
      .filter((h) => h.expose === false && methodCovered(h.methods, "GET") && globRegex(h.path).test("/"))
      .map((h) => h.path);
    if (by.length > 0) {
      const hiders = [...new Set(by)].sort();
      findings.push({
        app,
        kind: "launcher-target-hidden",
        subject: "ui.launcher",
        message: `the launcher tile opens ${app} at /, but ${hiders.join(" and ")} ${hiders.length === 1 ? "hides" : "hide"} it (expose: false), so the gateway answers 404 to everyone who opens the tile (narrow the hidden path, or drop the tile)`,
      });
    }
  }

  // 23. A launcher tile needs a start page: the tile opens `/`, and nothing serving it answers 404.
  const navLinksRoot = manifest.ui.nav.some((n) => (n.href.replace(/\/+$/, "") || "/") === "/");
  if (launcher && manifest.ui.status === "active" && !navLinksRoot) {
    const winner = navServed
      .filter((s) => routeUrlRegex(s.url).test("/"))
      .sort((a, b) => compareRouteSpecificity(a.url, b.url))[0];
    if (!winner?.get) {
      findings.push({
        app,
        kind: "launcher-target-missing",
        subject: "ui.launcher",
        ...(winner ? { file: rel(path.join(appDir, winner.file)) } : {}),
        message: winner
          ? `the launcher tile opens ${app} at /, but the route file serving / doesn't export GET, so the tile answers 405 to everyone who opens it (export GET, or serve / with a page)`
          : `the launcher tile opens ${app} at /, but no page or route file serves /, so the tile answers 404 to everyone who opens it (add app/page.tsx, or drop the tile)`,
      });
    }
  }

  // 24. A launcher tile the gateway guards: the tile opens `/`, and the gateway adds up the permissions
  // of every route matching it (`routeVerdict`), so a permission there contradicts the tile's access.
  // A hidden `/` answers 404 before any permission is asked (reported as `launcher-target-hidden`).
  if (launcher && manifest.ui.status === "active") {
    const atRoot = routes.filter((r) => methodCovered(r.methods, "GET") && globRegex(r.path).test("/"));
    const perms = [...new Set(atRoot.filter((r) => r.expose !== false).flatMap((r) => r.permission ?? []))].sort();
    if (perms.length > 0 && !atRoot.some((r) => r.expose === false)) {
      const named = perms.length === 1 ? `the permission ${perms[0]}` : `permissions (${perms.join(", ")})`;
      const them = perms.length === 1 ? "it" : "them";
      const asked = `manifest routes put ${named} on / for GET, and the gateway asks for ${them}`;
      const who =
        launcher.access === "public"
          ? `says anyone may open ${app} (access "public"), but ${asked}, so a signed-out visitor is sent to sign-in and a signed-in user without ${them} gets 403`
          : `says any signed-in user may open ${app} (access "authenticated"), but ${asked}, so a signed-in user without ${them} gets 403`;
      findings.push({
        app,
        kind: "launcher-target-guarded",
        subject: "ui.launcher",
        message: `the launcher tile ${who} (take the permission off /, for example by narrowing the route, or drop the tile)`,
      });
    }
  }

  // A subscription to an app in this repo that doesn't publish the type: the subscriber waits forever.
  const seenSubs = new Set<string>();
  for (const sub of manifest.events?.subscribes ?? []) {
    if (seenSubs.has(sub.type)) continue;
    seenSubs.add(sub.type);
    const owner = sub.type.slice(0, sub.type.indexOf("."));
    if (owner === "core") continue;
    const published = owner === app ? (manifest.events?.publishes ?? []).map((e) => e.type) : publishers.get(owner);
    if (!published || published.includes(sub.type)) continue;
    const base = unversioned(sub.type);
    const others = published.filter((t) => unversioned(t) === base).sort();
    findings.push({
      app,
      kind: "subscription-not-published",
      subject: sub.type,
      message: `subscribes to ${sub.type}, but ${owner}'s manifest doesn't publish it${
        others.length > 0 ? ` (it publishes ${others.join(", ")})` : ""
      }, so the subscription waits for an event that never comes (update the type, or drop the subscription)`,
    });
  }

  // 25. Code that reads DATABASE_URL needs a database: the platform hands it only for postgres.
  if (manifest.database.engine === "none" && !(manifest.secrets ?? []).includes("DATABASE_URL")) {
    const reader = files.find((f) => mentionsName(f.text, "DATABASE_URL"));
    if (reader) {
      findings.push({
        app,
        kind: "database-not-declared",
        subject: "DATABASE_URL",
        file: rel(path.join(appDir, reader.rel)),
        message: `the code reads DATABASE_URL, but the manifest says database.engine: "none", so the platform provisions no database and the read gets undefined at runtime (declare database.engine: "postgres" with its migrations, or list DATABASE_URL in secrets for a database the app brings itself)`,
      });
    }
  }

  // 26. A postgres database is read: the platform hands its URL only as DATABASE_URL.
  if (manifest.database.engine === "postgres" && !files.some((f) => mentionsName(f.text, "DATABASE_URL"))) {
    const prisma = sourceFiles(appDir, PRISMA_FILE).map((f) => readFileSync(path.join(appDir, f), "utf8"));
    if (!prisma.some((text) => mentionsName(text, "DATABASE_URL"))) {
      findings.push({
        app,
        kind: "database-never-read",
        subject: "DATABASE_URL",
        message: `the manifest says database.engine: "postgres", so the platform provisions a database and hands its URL as DATABASE_URL, but no code or Prisma schema reads DATABASE_URL (read process.env.DATABASE_URL where the code connects, or declare database.engine: "none" if the app no longer needs the database)`,
      });
    }
  }

  // 27. The migrator's default command needs that tool's schema or config in the app.
  if (manifest.database.engine === "postgres") {
    const tool = manifest.database.migrations;
    const missing =
      tool === "prisma"
        ? sourceFiles(appDir, PRISMA_FILE).length === 0
          ? "no *.prisma schema in the app"
          : undefined
        : tool === "drizzle"
          ? readdirSync(appDir, { withFileTypes: true }).some((e) => e.isFile() && DRIZZLE_CONFIG.test(e.name))
            ? undefined
            : "no drizzle.config.* at the app's root"
          : undefined;
    if (missing) {
      const command = tool === "prisma" ? "prisma migrate deploy" : "drizzle-kit migrate";
      findings.push({
        app,
        kind: "database-migrations-missing",
        subject: `migrations: ${tool}`,
        message: `the manifest says database.migrations: "${tool}", so the platform migrates the database with ${command}, but there is ${missing}, so the command fails and installing the app stops at its migrations (add it to the app, or declare the migrations the app really uses)`,
      });
    }
  }

  // 28. A worker can't take the name of the compose file's web service or migrator.
  for (const w of manifest.runtime.workers ?? []) {
    if (!RESERVED_SERVICE_NAMES.includes(w.name)) continue;
    findings.push({
      app,
      kind: "worker-name-reserved",
      subject: `worker: ${w.name}`,
      message: `the worker "${w.name}" has the name of the compose file's ${w.name === "web" ? "web service" : "migrator"}, so platform compose refuses to write the app's compose file and the app can't be deployed (rename the worker)`,
    });
  }

  // 29. With postgres, a declared secret can't take the name of a database variable the compose file generates.
  if (manifest.database.engine === "postgres") {
    const { app: appDsn, dsn, migratorDsn } = databaseVariableNames(manifest.id);
    const what = new Map([
      [appDsn, "the database URL the platform hands the app"],
      [dsn, "the web service's and workers' database URL"],
      [migratorDsn, "the migrator's database URL"],
    ]);
    for (const name of manifest.secrets ?? []) {
      if (!what.has(name)) continue;
      findings.push({
        app,
        kind: "secret-name-reserved",
        subject: `secret: ${name}`,
        message: `the secret ${name} has the name of ${what.get(name)} in the generated compose file, so platform compose refuses to write the app's compose file and the app can't be deployed (rename the secret, or drop it: the platform provisions the database)`,
      });
    }
  }

  // 30. The image's server listens on the port the gateway and the compose file reach it on.
  let dockerfile: string | undefined;
  try {
    dockerfile = readFileSync(path.join(appDir, "Dockerfile"), "utf8");
  } catch {
    dockerfile = undefined;
  }
  const port = dockerfile === undefined ? undefined : dockerfilePort(dockerfile);
  if (port !== undefined && /^\d+$/.test(port) && Number(port) !== manifest.runtime.port) {
    findings.push({
      app,
      kind: "runtime-port-mismatch",
      subject: `PORT=${port}`,
      file: rel(path.join(appDir, "Dockerfile")),
      message: `the Dockerfile sets ENV PORT=${port}, but the manifest says runtime.port: ${manifest.runtime.port}, which the gateway and the compose file reach the web service on, so the server listens on the wrong port and every request through the gateway fails (make them the same)`,
    });
  }

  // 31. A host belongs to one app: the gateway sends it to only one of the apps that claim it.
  for (const host of claimedHosts(manifest)) {
    // Claimants are told apart by folder; one whose folder isn't named after its id says where it is.
    const folder = path.basename(appDir);
    const others = (hosts.get(host) ?? [])
      .filter((c) => c.folder !== folder)
      .map((c) => (c.folder === c.id ? c.id : `${c.id} (apps/${c.folder})`));
    if (others.length === 0) continue;
    const how =
      host === manifest.domains?.primary
        ? "its domains.primary"
        : (manifest.domains?.aliases ?? []).includes(host)
          ? "a domains.aliases entry"
          : "its default host, as it has no domains.primary";
    findings.push({
      app,
      kind: "domain-claimed-twice",
      subject: `host: ${host}`,
      file: rel(path.join(appDir, MANIFEST_FILE)),
      message: `the host ${host} (${how}) is also claimed by ${others.join(", ")} in this repo, but the gateway sends a host to one app only, so every request to it reaches one of them and the other is unreachable at that host (give each app its own domain)`,
    });
  }

  // 32. Each config key reads a variable of its own, and no secret takes one of those names.
  for (const { variable, keys, secret } of configVariableClashes(manifest)) {
    const named = keys.length > 1 ? `config keys ${joinNames(keys)}` : `config key ${keys[0]}`;
    findings.push({
      app,
      kind: "config-variable-clash",
      subject: `variable: ${variable}`,
      message:
        secret !== undefined
          ? `the secret ${secret} has the name of the variable the ${named} ${keys.length > 1 ? "read their values" : "reads its value"} from, so the secret's value is read as config, and the app throws when it starts if that value isn't of the key's type (rename the secret)`
          : `the ${named} read the same variable, ${variable}, so setting it sets every one of them and they can't have different values (rename all but one of the keys)`,
    });
  }

  // 33. Where guarded routes overlap, the gateway asks for every one's permission: some role must grant them all.
  const candidates = [
    ...new Set([...routes.flatMap((r) => globSamples(r.path)), ...served.flatMap((s) => samplePaths(s.url))]),
  ].sort(byText);
  for (const stack of stackedRoutes(manifest, candidates)) {
    const named = stack.routes.map((r) => `${r.path} (${r.permission})`);
    findings.push({
      app,
      kind: "route-permissions-stacked",
      subject: `routes: ${stack.routes.map((r) => r.path).join(" + ")}`,
      file: rel(path.join(appDir, MANIFEST_FILE)),
      message: `the routes ${joinNames(named)} all match ${stack.method} ${stack.path}, and the gateway asks for every matching route's permission, but no role grants ${joinNames(stack.permissions)} together, so a user with only one of those roles gets 403 there (have one role grant them all, or narrow the broader route so they don't overlap)`,
    });
  }

  return { app, findings, handlers, plumbing };
}

/**
 * Sets of guarded, exposed routes that match the same path for the same method with different
 * permissions that no single role grants together (`route-permissions-stacked`), each with the first
 * sample path and method (in `HTTP_METHODS` order) it was found on. A path a route hides
 * (`expose: false`) for that method is skipped. One entry per set of routes, in manifest order.
 */
export function stackedRoutes(
  manifest: Pick<AppManifest, "id" | "routes" | "roles">,
  paths: readonly string[],
): { routes: { path: string; permission: string }[]; permissions: string[]; method: string; path: string }[] {
  const routes = (manifest.routes ?? []).map((r, i) => ({ ...r, i, re: globRegex(r.path) }));
  const guards = routes.filter((r) => r.expose !== false && r.permission !== undefined);
  const hiders = routes.filter((r) => r.expose === false);
  const all = `${manifest.id}.*`;
  const grantedTogether = (perms: string[]) =>
    manifest.roles.some((role) => role.grants.includes(all) || perms.every((p) => role.grants.includes(p)));
  const found = new Map<string, ReturnType<typeof stackedRoutes>[number]>();
  for (const p of paths) {
    for (const method of HTTP_METHODS) {
      if (hiders.some((h) => methodCovered(h.methods, method) && h.re.test(p))) continue;
      const hit = guards.filter((g) => methodCovered(g.methods, method) && g.re.test(p));
      const permissions = [...new Set(hit.map((g) => g.permission!))].sort(byText);
      if (permissions.length < 2 || grantedTogether(permissions)) continue;
      const key = hit.map((g) => g.i).join(",");
      if (found.has(key)) continue;
      found.set(key, {
        routes: hit.map((g) => ({ path: g.path, permission: g.permission! })),
        permissions,
        method,
        path: p,
      });
    }
  }
  return [...found.values()];
}

/**
 * The environment variables more than one of the manifest's names use (`config-variable-clash`): the
 * config keys that read each one (`envNameForConfigKey`, in manifest order), and the declared secret
 * of that name, if any. A variable only one name uses isn't listed.
 */
export function configVariableClashes(
  manifest: Pick<AppManifest, "config" | "secrets">,
): { variable: string; keys: string[]; secret?: string }[] {
  const byVariable = new Map<string, string[]>();
  for (const { key } of manifest.config ?? []) {
    const variable = envNameForConfigKey(key);
    byVariable.set(variable, [...(byVariable.get(variable) ?? []), key]);
  }
  const secrets = new Set(manifest.secrets ?? []);
  return [...byVariable].flatMap(([variable, keys]) => {
    const secret = secrets.has(variable) ? variable : undefined;
    return keys.length + (secret ? 1 : 0) > 1 ? [{ variable, keys, ...(secret ? { secret } : {}) }] : [];
  });
}

/** `a`, `a and b`, `a, b and c`. */
function joinNames(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * Paths that stand for every path a public glob covers, for proving that routes cover all of it:
 * each `*` becomes a segment no literal route names, and each `/**` becomes nothing, one segment, or
 * two segments marked `deep`. Only a route glob with its own `/**` may cover a deep sample, since one
 * without it matches a fixed depth.
 */
export function coverSamples(pattern: string): { path: string; deep: boolean }[] {
  // A segment no route literal can name: manifest route paths can't contain `%` (routePath).
  const ANY = "%any%";
  let forms = [{ path: "", deep: false }];
  pattern.split("/**").forEach((part, i) => {
    const lit = part.replace(/\*/g, ANY);
    forms =
      i === 0
        ? [{ path: lit, deep: false }]
        : forms.flatMap((f) => [
            { path: f.path + lit, deep: f.deep },
            { path: `${f.path}/${ANY}${lit}`, deep: f.deep },
            { path: `${f.path}/${ANY}/${ANY}${lit}`, deep: true },
          ]);
  });
  return forms.map((f) => ({ path: f.path || "/", deep: f.deep }));
}

/** URLs of the static files under `dir` (an app's `public/` folder), as Next.js serves them; none if it's missing. */
export function staticFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return; // missing, or not a folder
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(cur, entry.name), url);
      else if (entry.isFile()) out.push(url);
    }
  };
  walk(dir, "");
  return out.sort();
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

  // Every app's manifest is parsed and validated once, so cross-app checks see the apps not named too.
  const parsed = new Map<string, { manifest: AppManifest } | { error: string }>();
  for (const [id, text] of manifests) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      parsed.set(id, { error: `✖ apps/${id}/${MANIFEST_FILE}: not JSON (${(error as Error).message})` });
      continue;
    }
    const result = validateManifest(value);
    parsed.set(
      id,
      result.ok
        ? { manifest: result.manifest }
        : { error: `✖ apps/${id}/${MANIFEST_FILE}: not a valid manifest; run platform manifest validate first` },
    );
  }
  // Keyed by the manifest's own id: that is the namespace its event types carry.
  const publishers = new Map<string, string[]>();
  for (const entry of parsed.values()) {
    if ("manifest" in entry) {
      publishers.set(
        entry.manifest.id,
        (entry.manifest.events?.publishes ?? []).map((e) => e.type),
      );
    }
  }

  const hosts = hostClaims(
    [...parsed].flatMap(([folder, entry]) => ("manifest" in entry ? [{ folder, manifest: entry.manifest }] : [])),
  );

  const reviews: AppReview[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const entry = parsed.get(id)!;
    if ("error" in entry) {
      errors.push(entry.error);
      continue;
    }
    reviews.push(reviewApp(path.join(appsDir, id), entry.manifest, root, publishers, hosts));
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
