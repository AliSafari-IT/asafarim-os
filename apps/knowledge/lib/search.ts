/**
 * Public search (#357), over the search projection only (lib/search-index.ts), so it can only ever find published
 * articles. A query gathers candidates from four indexed paths: weighted full text (title A, tags and headings B,
 * summary C, body D), exact identifiers (`useEffect`, `err_connection_reset`, `c#`), identifier prefixes, and
 * trigram similarity of the title (misspellings), plus articles carrying a tag the query names. Facet filters apply
 * to the candidates before ranking and pagination. Pages are keyset on (score, id), so paging never repeats or
 * skips a result while the ranking is stable. Each result carries a snippet from its best-matching section and a
 * link to that section's heading.
 */
import type pg from "pg";
import { decodeCursor, encodeCursor } from "./cursor";
import { queryTerms } from "./identifiers";
import { LEVELS } from "./taxonomy";

type Pool = Pick<pg.Pool, "query">;

export const SEARCH_LIMITS = { query: 200, page: 20 } as const;
/** Marks around matched words in a snippet: control characters, so no author text can forge one. */
export const MATCH_START = "\u0002";
export const MATCH_END = "\u0003";

export interface SearchFilters {
  /** A topic slug: the topic and its child topics. */
  topic?: string | null;
  /** A tag slug (any kind). */
  tag?: string | null;
  /** A technology tag slug. */
  technology?: string | null;
  level?: string | null;
  language?: string | null;
  kind?: string | null;
}

export interface SearchHit {
  slug: string;
  title: string;
  summary: string;
  publishedAt: Date;
  level: string | null;
  topic: { slug: string; name: string } | null;
  /** Text with matched words between MATCH_START and MATCH_END; render with `snippetParts`. */
  snippet: string;
  section: { anchor: string; heading: string } | null;
}

export interface SearchPage {
  items: SearchHit[];
  next: string | null;
}

const HEADLINE = `MaxWords=32, MinWords=12, MaxFragments=2, FragmentDelimiter=" … ", StartSel=${MATCH_START}, StopSel=${MATCH_END}`;
const SCORE = /^\d{1,6}(?:\.\d{1,6})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeScoreCursor(score: string, id: string) {
  return Buffer.from(`s:${score}|${id}`, "utf8").toString("base64url");
}

function decodeScoreCursor(raw: unknown): { score: string; id: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const m = /^s:([^|]+)\|(.+)$/.exec(text);
  return m && SCORE.test(m[1]!) && UUID.test(m[2]!) ? { score: m[1]!, id: m[2]! } : null;
}

const likePrefix = (t: string) => `${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const clean = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

/** The facet filters, normalised: anything malformed is dropped rather than sent to SQL. */
export function normaliseFilters(f: SearchFilters): Required<SearchFilters> {
  const slug = (v: string | null | undefined) => {
    const s = clean(v);
    return s && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 64 ? s : null;
  };
  const level = clean(f.level);
  const language = clean(f.language);
  return {
    topic: slug(f.topic),
    tag: slug(f.tag),
    technology: slug(f.technology),
    level: level && (LEVELS as readonly string[]).includes(level) ? level : null,
    language: language && /^[a-z]{2}$/.test(language) ? language : null,
    kind: clean(f.kind) === "article" ? "article" : null,
  };
}

// The facet filter, shared by both queries; parameters $1..$6 are the normalised filters.
const FACETS = `
  ($1::text IS NULL OR d.topic_id IN (SELECT id FROM topics WHERE slug = $1
                                      UNION SELECT c.id FROM topics c JOIN topics p ON p.id = c.parent_id WHERE p.slug = $1))
  AND ($2::text IS NULL OR d.tag_ids && ARRAY(SELECT id FROM tags WHERE slug = $2))
  AND ($3::text IS NULL OR d.tag_ids && ARRAY(SELECT id FROM tags WHERE slug = $3 AND kind = 'technology'))
  AND ($4::text IS NULL OR d.level = $4)
  AND ($5::text IS NULL OR d.language = $5)
  AND ($6::text IS NULL OR d.kind = $6)`;

const HIT_COLUMNS = `d.item_id, d.slug, d.title, d.summary, d.published_at, d.level, t.slug AS topic_slug, t.name AS topic_name`;

interface HitRow {
  item_id: string;
  slug: string;
  title: string;
  summary: string;
  published_at: Date;
  level: string | null;
  topic_slug: string | null;
  topic_name: string | null;
  snippet: string | null;
  anchor: string | null;
  heading: string | null;
}

const toHit = (r: HitRow): SearchHit => ({
  slug: r.slug,
  title: r.title,
  summary: r.summary,
  publishedAt: r.published_at,
  level: r.level,
  topic: r.topic_slug ? { slug: r.topic_slug, name: r.topic_name ?? r.topic_slug } : null,
  snippet: r.snippet ?? r.summary,
  section: r.anchor ? { anchor: r.anchor, heading: r.heading ?? "" } : null,
});

/**
 * One page of results. An empty query lists the filtered articles newest first (what a topic page shows); a query
 * ranks them. `after` is the cursor of the previous page's last result.
 */
export async function searchPublished(
  pool: Pool,
  input: { q?: string | null; filters?: SearchFilters; after?: string | null; limit?: number },
): Promise<SearchPage> {
  const limit = Math.min(Math.max(input.limit ?? SEARCH_LIMITS.page, 1), 50);
  const f = normaliseFilters(input.filters ?? {});
  const facetParams = [f.topic, f.tag, f.technology, f.level, f.language, f.kind];
  const q = (input.q ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_LIMITS.query);
  const terms = queryTerms(q);

  if (!q || terms.length === 0) {
    const after = decodeCursor(input.after);
    const { rows } = await pool.query<HitRow & { at_key: string }>(
      `SELECT ${HIT_COLUMNS}, d.published_at::text AS at_key, NULL AS snippet, NULL AS anchor, NULL AS heading
       FROM search_documents d LEFT JOIN topics t ON t.id = d.topic_id
       WHERE ${FACETS}
         AND ($7::timestamptz IS NULL OR (d.published_at, d.item_id) < ($7::timestamptz, $8::text))
       ORDER BY d.published_at DESC, d.item_id DESC LIMIT $9`,
      [...facetParams, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return {
      items: shown.map(toHit),
      next: rows.length > limit && last ? encodeCursor({ at: last.at_key, id: last.item_id }) : null,
    };
  }

  const after = decodeScoreCursor(input.after);
  const prefixes = terms.filter((t) => t.length >= 3).map(likePrefix);
  const { rows } = await pool.query<HitRow & { score: string }>(
    `WITH query AS (SELECT websearch_to_tsquery('simple', $7) AS tq, lower($7) AS lq),
     named_tags AS (
       SELECT id FROM tags WHERE slug = ANY($8::text[]) OR lower(name) = ANY($8::text[]) OR lower(name) = (SELECT lq FROM query)
       UNION SELECT tag_id FROM tag_aliases WHERE alias = ANY($8::text[]) OR alias = (SELECT lq FROM query)
     ),
     candidates AS (
       SELECT d.item_id FROM search_documents d, query WHERE d.tsv @@ query.tq
       UNION SELECT item_id FROM search_terms WHERE term = ANY($8::text[])
       UNION SELECT st.item_id FROM unnest($9::text[]) AS p JOIN search_terms st ON st.term LIKE p
       UNION SELECT d.item_id FROM search_documents d, query WHERE lower(d.title) % query.lq
       UNION SELECT d.item_id FROM search_documents d WHERE d.tag_ids && ARRAY(SELECT id FROM named_tags)
     ),
     scored AS (
       SELECT d.*, round((
           3 * (SELECT count(*) FROM search_terms st WHERE st.item_id = d.item_id AND st.term = ANY($8::text[]))::numeric
             / greatest(cardinality($8::text[]), 1)
         + CASE WHEN EXISTS (SELECT 1 FROM unnest($9::text[]) AS p JOIN search_terms st
                             ON st.item_id = d.item_id AND st.term LIKE p) THEN 0.5 ELSE 0 END
         + 4 * ts_rank('{0.1, 0.2, 0.4, 1.0}', d.tsv, query.tq)::numeric
         + 2 * similarity(lower(d.title), query.lq)::numeric
         + CASE WHEN d.tag_ids && ARRAY(SELECT id FROM named_tags) THEN 1.5 ELSE 0 END
       ), 6) AS score
       FROM candidates c JOIN search_documents d ON d.item_id = c.item_id, query
       WHERE ${FACETS}
     ),
     -- Rank and cut the page first; only the page's rows get a snippet (ts_headline is the expensive part).
     page AS (
       SELECT * FROM scored d
       WHERE ($10::numeric IS NULL OR (d.score, d.item_id) < ($10::numeric, $11::text))
       ORDER BY d.score DESC, d.item_id DESC
       LIMIT $12
     )
     SELECT ${HIT_COLUMNS}, d.score::text AS score, s.snippet, s.anchor, s.heading
     FROM page d CROSS JOIN query LEFT JOIN topics t ON t.id = d.topic_id
     LEFT JOIN LATERAL (
       SELECT x.anchor, x.heading, ts_headline('simple', x.body, query.tq, $13) AS snippet
       FROM search_sections x
       WHERE x.item_id = d.item_id
       ORDER BY ts_rank(x.tsv, query.tq) DESC,
                (SELECT count(*) FROM unnest($8::text[]) AS w WHERE position(w IN lower(x.body)) > 0) DESC,
                x.position
       LIMIT 1
     ) s ON true
     ORDER BY d.score DESC, d.item_id DESC`,
    [...facetParams, q, terms, prefixes, after?.score ?? null, after?.id ?? null, limit + 1, HEADLINE],
  );
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    items: shown.map(toHit),
    next: rows.length > limit && last ? encodeScoreCursor(last.score, last.item_id) : null,
  };
}

/** A snippet as plain parts to render (React escapes each), matched words flagged. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let rest = snippet;
  while (rest) {
    const start = rest.indexOf(MATCH_START);
    if (start < 0) {
      out.push({ text: rest, match: false });
      break;
    }
    if (start > 0) out.push({ text: rest.slice(0, start), match: false });
    const end = rest.indexOf(MATCH_END, start + 1);
    const stop = end < 0 ? rest.length : end;
    out.push({ text: rest.slice(start + 1, stop), match: true });
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  return out.filter((p) => p.text);
}

/**
 * The studio's own search (#357): the person's articles (every article for an editor) whose draft title or slug
 * contains the words, drafts included. Authenticated and separate from the public search, which never sees drafts.
 */
export async function searchStudio(
  pool: Pool,
  actor: { subject: string; seesAll: boolean },
  q: string,
  limit = 50,
): Promise<{ id: string; slug: string; title: string; status: string; updatedAt: Date }[]> {
  const words = q.trim().toLowerCase().slice(0, SEARCH_LIMITS.query);
  if (!words) return [];
  const { rows } = await pool.query<{
    id: string;
    slug: string;
    title: string;
    published_revision_id: string | null;
    withdrawn_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT i.id, i.slug, r.title, i.published_revision_id, i.withdrawn_at, i.updated_at
     FROM content_items i JOIN content_revisions r ON r.id = i.draft_revision_id
     WHERE ($1::boolean OR i.owner_subject = $2)
       AND (lower(r.title) LIKE $3 ESCAPE '\\' OR i.slug LIKE $3 ESCAPE '\\' OR word_similarity($4, lower(r.title)) > 0.5)
     ORDER BY word_similarity($4, lower(r.title)) DESC, i.updated_at DESC LIMIT $5`,
    [actor.seesAll, actor.subject, `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, words, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    status: r.published_revision_id ? "published" : r.withdrawn_at ? "withdrawn" : "draft",
    updatedAt: r.updated_at,
  }));
}
