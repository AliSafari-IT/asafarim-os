/**
 * `platform events`: the event catalog from the command line, the same data as Admin's Events page (P4.2).
 *
 *   platform events [--app <id>] [--json]   every event type, sorted by type, with its publisher, schema status
 *                                           and subscribers (GET /admin/v1/events); --app keeps the types the app
 *                                           publishes or subscribes to; --json prints those entries as JSON
 *   platform events schema <type>           the JSON schema the type's publisher uploaded, as text
 *   platform events search <words> [--app <id>] [--json]
 *                                           the types those words find, best first: Admin's keyword search
 *                                           (P7.4 part 1, @asafarim/event-catalog) over the same catalog
 *
 * Read-only. It talks to the admin API as `platform status` does (`adminEndpoint`: CORE_API_URL and
 * CORE_API_ADMIN_TOKEN, falling back to `.dev/core-api.env` locally). Exit code 0 when core-api answered,
 * 1 when it can't be asked, refuses, answers with something that isn't a catalog, or (schema) the type
 * isn't in the catalog or has no schema. A search that finds nothing is an answer, so it exits 0.
 */
import { type MatchField, eventsQuery, queryTerms, searchCatalog } from "@asafarim/event-catalog";
import { adminEndpoint } from "./app.ts";
import { commonRefusal, formatDate, request } from "./retention.ts";
import { clean } from "./status.ts";

type Result = { ok: boolean; lines: string[]; stdout?: boolean };

/** The app ids core-api accepts (as `role list --app`), checked first so a typo isn't a request. */
const APP_ID = /^(?:core|[a-z][a-z0-9-]{1,31})$/;
/** An event type as manifests declare it (`<app>.<entity>.<verb>[.v<n>]`); loose on purpose, it only filters. */
const EVENT_TYPE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

export type EventsArgs =
  | { action: "list"; app?: string; json: boolean }
  | { action: "schema"; type: string }
  | { action: "search"; query: string; app?: string; json: boolean };

/** `events …` (the words after `events`); null = not valid (the usage is printed). */
export function parseEventsArgs(args: string[]): EventsArgs | null {
  if (args[0] === "schema") {
    if (args.length !== 2 || !EVENT_TYPE.test(args[1]!)) return null;
    return { action: "schema", type: args[1]! };
  }
  const search = args[0] === "search";
  const words: string[] = [];
  let json = false;
  let app: string | undefined;
  for (let i = search ? 1 : 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json" && !json) json = true;
    else if (a === "--app" && app === undefined && args[i + 1] !== undefined) {
      app = args[++i]!;
      if (!APP_ID.test(app)) return null;
    } else if (search && !a.startsWith("--")) words.push(a);
    else return null;
  }
  const filter = app !== undefined ? { app } : {};
  if (!search) return { action: "list", json, ...filter };
  // The words, as one query cut as the page cuts `?q=` (MAX_QUERY_LENGTH); none: nothing to search for.
  const query = eventsQuery(words.join(" "));
  return query === undefined ? null : { action: "search", query, json, ...filter };
}

/** A subscriber (mirrors core-api's `CatalogSubscriber`, core/core-api/src/admin.ts). */
export interface CatalogSubscriber {
  appId: string;
  state: string;
  handler: string;
  consumer: "bound" | "waiting_for_publisher";
}

/** One event type (mirrors core-api's `CatalogEntry`, core/core-api/src/admin.ts). */
export interface CatalogEntry {
  type: string;
  publisher: { appId: string; version: string; state: string } | null;
  schema: object | null;
  schemaStatus: "provided" | "not_provided" | "no_publisher";
  schemaUpdatedAt: string | null;
  schemaAppVersion: string | null;
  subscribers: CatalogSubscriber[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * core-api's reply as a catalog, or null when it isn't one (no `events` array, or an entry without a string
 * type or a subscribers array): the command then fails instead of formatting garbage.
 */
export function asCatalog(out: unknown): CatalogEntry[] | null {
  if (!isObject(out) || !Array.isArray(out.events)) return null;
  const ok = out.events.every(
    (e) =>
      isObject(e) &&
      typeof e.type === "string" &&
      typeof e.schemaStatus === "string" &&
      Array.isArray(e.subscribers) &&
      e.subscribers.every((s) => isObject(s)) &&
      (e.publisher === null || isObject(e.publisher)),
  );
  return ok ? (out.events as unknown as CatalogEntry[]) : null;
}

/** The catalog sorted by type, keeping only what `app` publishes or subscribes to (Admin's `catalogFor`). */
export function catalogFor(entries: CatalogEntry[], app?: string): CatalogEntry[] {
  return entries
    .filter((e) => !app || e.publisher?.appId === app || e.subscribers.some((s) => s.appId === app))
    .slice()
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** Padded columns, the last one not padded (`status`'s, `audit`'s and `app list`'s style). */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

const noPublisher = (e: CatalogEntry) => e.publisher === null || e.schemaStatus === "no_publisher";

function publisherCell(e: CatalogEntry): string {
  if (!e.publisher) return "–";
  return `${clean(e.publisher.appId)}@${clean(e.publisher.version)}`;
}

function schemaCell(e: CatalogEntry): string {
  if (noPublisher(e)) return "no publisher";
  if (e.schemaStatus === "provided") return "provided";
  if (e.schemaStatus === "not_provided") return "not provided";
  return clean(e.schemaStatus);
}

/** Subscribers as `app` (bound) or `app (waiting)`; none: a dash. */
function subscribersCell(e: CatalogEntry): string {
  if (e.subscribers.length === 0) return "–";
  return e.subscribers
    .map((s) => (s.consumer === "waiting_for_publisher" ? `${clean(s.appId)} (waiting)` : clean(s.appId)))
    .join(", ");
}

export function formatCatalog(entries: CatalogEntry[], app?: string): string[] {
  if (entries.length === 0) {
    return [
      app === undefined ? "core-api lists no event types." : `${clean(app)} publishes and subscribes to nothing.`,
    ];
  }
  const rows = entries.map((e) => [clean(e.type), publisherCell(e), schemaCell(e), subscribersCell(e)]);
  const lines = table(["Type", "Publisher", "Schema", "Subscribers"], rows);
  const dangling = entries
    .filter(noPublisher)
    .map((e) => `  ${clean(e.type)}: subscribed to by ${subscribersCell(e)}, but no installed app publishes it`);
  const missing = entries
    .filter((e) => !noPublisher(e) && e.schemaStatus === "not_provided")
    .map((e) => `  ${clean(e.type)}: ${publisherCell(e)} publishes it but hasn't uploaded a schema`);
  if (dangling.length) lines.push("", "No publisher (a warning; the subscribers wait):", ...dangling);
  if (missing.length) lines.push("", "No schema yet (see pnpm platform events schema <type>):", ...missing);
  return lines;
}

/** One type's schema as text, with where it came from; a lookup that finds nothing to print fails. */
export function formatSchema(entries: CatalogEntry[], type: string): Result {
  const e = entries.find((x) => x.type === type);
  if (!e) return { ok: false, lines: [`core-api's catalog has no event type "${clean(type)}".`] };
  if (noPublisher(e)) return { ok: false, lines: [`No installed app publishes ${clean(type)}, so it has no schema.`] };
  if (!isObject(e.schema) || e.schemaStatus !== "provided") {
    return { ok: false, lines: [`${publisherCell(e)} publishes ${clean(type)} but hasn't uploaded a schema.`] };
  }
  const from = `${clean(type)}: uploaded by ${clean(e.publisher?.appId)}@${clean(e.schemaAppVersion ?? "?")}, ${clean(
    formatDate(e.schemaUpdatedAt),
  )}`;
  // JSON.stringify escapes C0 controls in strings; clean() catches the C1 ones it leaves.
  const body = JSON.stringify(e.schema, null, 2).split("\n").map(clean);
  return { ok: true, stdout: true, lines: [from, "", ...body] };
}

const MATCHED: Record<MatchField, string> = {
  type: "type",
  app: "app",
  description: "description",
  property: "schema property",
};

/** Search hits, best first: the type, its score, where the words matched, and who publishes it. */
export function formatSearch(entries: CatalogEntry[], query: string, app?: string): string[] {
  const hits = searchCatalog(entries, query);
  const terms = queryTerms(query).map(clean).join(", ");
  const where = app === undefined ? "" : ` among ${clean(app)}'s types`;
  if (hits.length === 0) return [`No event type matches "${clean(query)}"${where} (searched for: ${terms}).`];
  const rows = hits.map((h) => [
    clean(h.entry.type),
    String(h.score),
    h.matched.map((f) => MATCHED[f]).join(", "),
    publisherCell(h.entry),
  ]);
  return [
    `${hits.length} event ${hits.length === 1 ? "type matches" : "types match"} "${clean(query)}"${where} (searched for: ${terms}).`,
    "",
    ...table(["Type", "Score", "Matched in", "Publisher"], rows),
    "",
    "Every word must match. See a type's schema with pnpm platform events schema <type>.",
  ];
}

const EVENTS = "/admin/v1/events";

/** A refusal: a 404 on this fixed route means core-api lacks it. */
function refusal(r: Parameters<typeof commonRefusal>[0]): string[] {
  if (!("unreachable" in r) && r.error === "not_found") return [`core-api has no ${EVENTS}.`];
  return commonRefusal(r, "", "").filter(Boolean);
}

export async function eventsCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const p = parseEventsArgs(args);
  if (!p) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  const r = await request(target, "GET", EVENTS, fetchImpl);
  if (!r.ok) return { ok: false, lines: refusal(r) };
  const catalog = asCatalog(r.out);
  if (!catalog) return { ok: false, lines: [`core-api's reply to GET ${EVENTS} isn't what this CLI expects.`] };

  if (p.action === "schema") return formatSchema(catalog, p.type);
  const entries = catalogFor(catalog, p.app);
  if (p.action === "search") {
    if (!p.json) return { ok: true, stdout: true, lines: formatSearch(entries, p.query, p.app) };
    const hits = searchCatalog(entries, p.query).map((h) => ({ score: h.score, matched: h.matched, entry: h.entry }));
    const out = { query: p.query, terms: queryTerms(p.query), hits };
    return { ok: true, stdout: true, lines: [JSON.stringify(out, null, 2)] };
  }
  if (p.json) return { ok: true, stdout: true, lines: [JSON.stringify({ events: entries }, null, 2)] };
  return { ok: true, stdout: true, lines: formatCatalog(entries, p.app) };
}
