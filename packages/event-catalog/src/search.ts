/**
 * Keyword search over the event catalog (P7.4 part 1, ADR 0001). Moved here from core/admin/lib/events.ts so the
 * Admin console's Events page and `platform events search` run the same code.
 */

/** What the search reads of a catalog entry (core-api's `CatalogEntry`, core/core-api/src/admin.ts, has more). */
export interface SearchableEntry {
  type: string;
  publisher: { appId: string } | null;
  schema: object | null;
  subscribers: { appId: string }[];
}

/* ── P7.4 part 1: event-catalog search ──────────────────────────────────────────────────────────────────
 * Deterministic keyword search over what the catalog already holds: no model, no network, no core-api change.
 * "Which app emits something when an order ships?" keeps "order" and "ships", folds "ships" to "ship", and
 * finds `shop.order.shipped.v1`, or a type whose schema describes the shipment. Every kept word must match. */

/** Longest query the page (`?q=`) and the CLI accept; anything longer is cut, never rejected. */
export const MAX_QUERY_LENGTH = 100;

/** Where a word matched, from the strongest signal to the weakest. */
export type MatchField = "type" | "app" | "description" | "property";
const FIELD_ORDER: MatchField[] = ["type", "app", "description", "property"];
const WEIGHT: Record<MatchField, number> = { type: 4, description: 3, app: 2, property: 1 };

/** Question words and catalog vocabulary that every entry would match, so they narrow nothing. */
const STOP_WORDS = new Set(
  (
    "a an and any app apps are about by can does do emit emits emitted event events for from has have how i in is " +
    "it me of on or publish publishes published send sends sent something some that the there to type types what " +
    "when where which who will with"
  ).split(" "),
);

/** A query as the page (`?q=`) and the CLI apply it: a trimmed string, cut to MAX_QUERY_LENGTH; anything else is nothing. */
export function eventsQuery(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const q = raw.trim().slice(0, MAX_QUERY_LENGTH).trim();
  return q === "" ? undefined : q;
}

/** Folds a lower-case word to a rough stem: "ships", "shipped" and "shipping" all start with "ship". */
export function stem(word: string): string {
  const cut = (n: number) => (word.length - n >= 3 ? word.slice(0, -n) : word);
  if (word.endsWith("ing")) return cut(3);
  if (word.endsWith("ed")) return cut(2);
  // "boxes", "batches", "pushes" lose "es"; "notes", "types" only lose the "s".
  if (/(s|x|z|ch|sh)es$/.test(word)) return cut(2);
  if (word.endsWith("s") && !word.endsWith("ss")) return cut(1);
  return word;
}

/** Lower-case words of a text, split on anything that isn't a letter or digit and on camelCase. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

/** The words a query searches for (stemmed, de-duplicated). Only stop words? Then those, so a query never matches all. */
export function queryTerms(q: string): string[] {
  const all = words(q);
  const kept = all.filter((w) => !STOP_WORDS.has(w));
  return [...new Set((kept.length > 0 ? kept : all).map(stem))];
}

const SKIP_KEYS = new Set(["enum", "const", "default", "examples", "example"]);
const MAX_DEPTH = 12;
const MAX_NODES = 2000;

/** The schema's own title and description, and every property name, title and description below it. */
export function schemaTexts(schema: object | null): { description: string[]; property: string[] } {
  const out = { description: [] as string[], property: [] as string[] };
  if (schema === null) return out;
  let nodes = 0;
  const visit = (node: unknown, depth: number, root: boolean): void => {
    if (node === null || typeof node !== "object" || depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1, false);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ["title", "description"]) {
      const text = obj[key];
      if (typeof text === "string") (root ? out.description : out.property).push(text);
    }
    const props = obj.properties;
    if (props !== null && typeof props === "object" && !Array.isArray(props)) out.property.push(...Object.keys(props));
    for (const [key, child] of Object.entries(obj)) {
      if (!SKIP_KEYS.has(key)) visit(child, depth + 1, false);
    }
  };
  visit(schema, 0, true);
  return out;
}

/** One search result: the entry, its score, and the fields some word matched in (strongest first). */
export interface SearchHit<E extends SearchableEntry = SearchableEntry> {
  entry: E;
  score: number;
  matched: MatchField[];
}

/**
 * The words of some texts as the matcher sees them: each word stemmed, and also as written when the stem differs.
 * Keeping the written word lets "speeds" (stem "speed") find "speed", whose stem is the 3-letter "spe" that is too
 * short to match by itself.
 */
export function fieldWords(texts: string[]): string[] {
  return texts.flatMap(words).flatMap((w) => {
    const s = stem(w);
    return s === w ? [w] : [s, w];
  });
}

function entryWords(entry: SearchableEntry): Record<MatchField, string[]> {
  const texts = schemaTexts(entry.schema);
  // Typed as strings, but the CLI reads core-api's reply as JSON: anything else is no words, never a throw.
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const apps = [text(entry.publisher?.appId), ...entry.subscribers.map((s) => text(s.appId))];
  return {
    type: fieldWords([entry.type]),
    app: fieldWords(apps),
    description: fieldWords(texts.description),
    property: fieldWords(texts.property),
  };
}

/**
 * A query word matches a field word that starts with it ("ship" matches "shipment"), or one of at least four letters
 * it starts with ("create" matches "created", whose stem is "creat").
 */
const matches = (candidates: string[], term: string): boolean =>
  candidates.some((w) => w.startsWith(term) || (w.length >= 4 && term.startsWith(w)));

/**
 * The entries every query word matches, best first. A word scores the weight of the strongest field it matches
 * (type 4, description 3, app 2, property 1); ties keep the catalog's type order. No words: no results.
 */
export function searchCatalog<E extends SearchableEntry>(entries: E[], q: string): SearchHit<E>[] {
  const terms = queryTerms(q);
  if (terms.length === 0) return [];
  const hits: SearchHit<E>[] = [];
  for (const entry of entries) {
    const fields = entryWords(entry);
    const matched = new Set<MatchField>();
    let score = 0;
    let all = true;
    for (const term of terms) {
      const found = FIELD_ORDER.filter((f) => matches(fields[f], term));
      if (found.length === 0) {
        all = false;
        break;
      }
      for (const f of found) matched.add(f);
      score += Math.max(...found.map((f) => WEIGHT[f]));
    }
    if (all) hits.push({ entry, score, matched: FIELD_ORDER.filter((f) => matched.has(f)) });
  }
  return hits.sort(
    (a, b) => b.score - a.score || (a.entry.type < b.entry.type ? -1 : a.entry.type > b.entry.type ? 1 : 0),
  );
}
