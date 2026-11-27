/**
 * The counts: one row per day, kind, page and label, with a number in it. Nothing else: there is no column for an
 * address, a browser, a cookie, a session or a person, so a row can't hold one (test/analytics.integration.test.ts
 * checks the columns). Recording is an increment; reading is a handful of sums.
 *
 * Pure with respect to the framework (it takes a pool), so it can move into a shared package for the other apps.
 */
import type pg from "pg";
import {
  isShareTarget,
  looksLikeBot,
  optedOut,
  readerName,
  type AnalyticsKind,
  type HeaderBag,
  type ShareTarget,
} from "./classify";

type Pool = Pick<pg.Pool, "query">;

/** Daily totals older than this are deleted (about 26 months). */
export const RETENTION_DAYS = 800;
/** What people searched for is kept for much less. */
export const SEARCH_RETENTION_DAYS = 90;
/** The Insights page shows a search term only once at least this many searches made it. */
export const MIN_SEARCH_COUNT = 3;
export const PERIODS = [7, 30, 90] as const;

/** Count one event on `at`'s UTC day. */
export async function recordEvent(
  pool: Pool,
  kind: AnalyticsKind,
  key: string,
  dim = "",
  at = new Date(),
): Promise<void> {
  await pool.query(
    `INSERT INTO analytics_daily (day, kind, key, dim, count)
     VALUES (($4::timestamptz AT TIME ZONE 'utc')::date, $1, $2, $3, 1)
     ON CONFLICT (day, kind, key, dim) DO UPDATE SET count = analytics_daily.count + 1`,
    [kind, key.slice(0, 200), dim.slice(0, 100), at],
  );
}

/**
 * Count a click on a share button, only for an article that is published (so a made-up address can't add rows).
 * Returns whether it was counted.
 */
export async function recordShare(pool: Pool, slug: string, target: ShareTarget, at = new Date()): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO analytics_daily (day, kind, key, dim, count)
     SELECT ($3::timestamptz AT TIME ZONE 'utc')::date, 'share', 'article:' || i.slug, $2, 1
     FROM content_items i WHERE i.slug = $1 AND i.published_revision_id IS NOT NULL
     ON CONFLICT (day, kind, key, dim) DO UPDATE SET count = analytics_daily.count + 1`,
    [slug, target, at],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Count a fetch of the RSS feed, by the reader that made it (an allow-list of well-known names; never the raw browser
 * string). A crawler or script is not counted.
 */
export async function recordFeedFetch(pool: Pool, h: HeaderBag, at = new Date()): Promise<void> {
  if (optedOut(h)) return;
  const reader = readerName(h.get("user-agent"));
  if (reader) await recordEvent(pool, "feed", "feed", reader, at);
}

/** Delete what has outlived its retention. */
export async function purgeOldAnalytics(pool: Pool, now = new Date()): Promise<void> {
  await pool.query(
    `DELETE FROM analytics_daily
     WHERE day < ($1::timestamptz AT TIME ZONE 'utc')::date - $2::int
        OR (kind = 'search' AND day < ($1::timestamptz AT TIME ZONE 'utc')::date - $3::int)`,
    [now, RETENTION_DAYS, SEARCH_RETENTION_DAYS],
  );
}

/**
 * The request body as text, or null when it is longer than `max` bytes. The declared length is checked first, and the
 * stream is read only up to the limit, so an oversized (or unannounced chunked) body is never held in memory.
 */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A share-button click reported by the page's own script (POST /api/public/analytics/event). It must come from this
 * site's own pages, from a browser that did not opt out, with a small JSON body naming a share target and a
 * published article. Anything else is ignored without an answer that says why. Returns whether it was counted.
 */
export async function handleShareRequest(pool: Pool, request: Request, at = new Date()): Promise<boolean> {
  const h: HeaderBag = request.headers;
  if (optedOut(h) || looksLikeBot(h.get("user-agent"))) return false;
  const site = h.get("sec-fetch-site");
  if (site !== "same-origin") {
    // A browser that sends no fetch metadata: accept only a request whose Origin is this very host.
    if (site) return false;
    const origin = h.get("origin");
    const host = h.get("host");
    if (!origin || !host) return false;
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  const text = await readCapped(request, 512);
  if (text === null) return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object") return false;
  const { type, slug, target } = body as Record<string, unknown>;
  if (type !== "share" || typeof slug !== "string" || slug.length > 96 || !isShareTarget(target)) return false;
  return recordShare(pool, slug, target, at);
}

// ---- Reading ---------------------------------------------------------------------------------------------------

export interface Counted {
  label: string;
  count: number;
}

export interface ArticleInsight {
  slug: string;
  title: string;
  /** False once the article has been withdrawn: its history stays, but its public page is gone. */
  published: boolean;
  views: number;
  shares: Partial<Record<ShareTarget, number>>;
  shareTotal: number;
}

export interface Insights {
  days: number;
  from: string;
  to: string;
  totals: { views: number; shares: number; feedFetches: number | null };
  daily: { day: string; views: number }[];
  articles: ArticleInsight[];
  /** Site-wide sections: null for someone who sees only their own articles. */
  referrers: Counted[] | null;
  searches: Counted[] | null;
  pages: Counted[] | null;
  readers: Counted[] | null;
  shareTargets: Counted[] | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The `days` UTC days ending on `today`'s: first, last and every day between. */
export function windowOf(days: number, today = new Date()): { from: string; to: string; list: string[] } {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const list: string[] = [];
  for (let i = days - 1; i >= 0; i--) list.push(isoDay(new Date(end - i * 86_400_000)));
  return { from: list[0]!, to: list[list.length - 1]!, list };
}

export const parsePeriod = (raw: unknown): number => {
  const n = Number(raw);
  return (PERIODS as readonly number[]).includes(n) ? n : 30;
};

const n = (v: unknown) => Number(v ?? 0);

/**
 * What the Insights page shows. `all` (an editor) sees the whole site; anyone else sees only the articles they own, and
 * none of the site-wide sections (referrers, searches, other pages, the feed).
 */
export async function getInsights(
  pool: Pool,
  who: { subject: string; all: boolean },
  days: number,
  today = new Date(),
): Promise<Insights> {
  const w = windowOf(days, today);
  const range = [w.from, w.to] as const;
  const own = (alias: string) => (who.all ? "TRUE" : `${alias}.owner_subject = $3`);
  const ownParams = who.all ? [] : [who.subject];

  // An article's events are stored under the address it had when they happened. Both its current address and every
  // old one it keeps as a redirect lead to the same article, so a rename does not hide its history.
  const NAMES = `names AS (
    SELECT 'article:' || slug AS key, id FROM content_items
    UNION ALL SELECT 'article:' || old_slug, item_id FROM slug_redirects
  )`;

  const dailyRows = (
    await pool.query<{ day: string; views: string }>(
      who.all
        ? `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(count) AS views FROM analytics_daily
           WHERE kind = 'view' AND day BETWEEN $1 AND $2 GROUP BY day`
        : `WITH ${NAMES}
           SELECT to_char(a.day, 'YYYY-MM-DD') AS day, sum(a.count) AS views FROM analytics_daily a
           JOIN names n ON n.key = a.key JOIN content_items i ON i.id = n.id
           WHERE a.kind = 'view' AND a.day BETWEEN $1 AND $2 AND ${own("i")} GROUP BY a.day`,
      [...range, ...ownParams],
    )
  ).rows;
  const byDay = new Map(dailyRows.map((r) => [r.day, n(r.views)]));
  const daily = w.list.map((day) => ({ day, views: byDay.get(day) ?? 0 }));

  // Views and shares together, so an article that was only shared in this period still has a row.
  const eventRows = (
    await pool.query<{ slug: string; title: string; published: boolean; kind: string; dim: string; count: string }>(
      `WITH ${NAMES}, ev AS (
         SELECT n.id, a.kind, a.dim, sum(a.count) AS count
         FROM analytics_daily a JOIN names n ON n.key = a.key
         WHERE a.kind IN ('view', 'share') AND a.day BETWEEN $1 AND $2
         GROUP BY n.id, a.kind, a.dim
       )
       SELECT i.slug, r.title, i.published_revision_id IS NOT NULL AS published, ev.kind, ev.dim, ev.count
       FROM ev JOIN content_items i ON i.id = ev.id
       JOIN content_revisions r ON r.id = i.draft_revision_id
       WHERE ${own("i")}`,
      [...range, ...ownParams],
    )
  ).rows;

  const bySlug = new Map<string, ArticleInsight>();
  let shares = 0;
  for (const e of eventRows) {
    let a = bySlug.get(e.slug);
    if (!a) {
      a = { slug: e.slug, title: e.title, published: e.published, views: 0, shares: {}, shareTotal: 0 };
      bySlug.set(e.slug, a);
    }
    if (e.kind === "view") a.views += n(e.count);
    else {
      shares += n(e.count);
      if (isShareTarget(e.dim)) {
        a.shares[e.dim] = (a.shares[e.dim] ?? 0) + n(e.count);
        a.shareTotal += n(e.count);
      }
    }
  }
  const articles = [...bySlug.values()]
    .sort((x, y) => y.views - x.views || y.shareTotal - x.shareTotal || x.title.localeCompare(y.title))
    .slice(0, 25);

  const sum = async (sql: string, params: unknown[]): Promise<Counted[]> =>
    (await pool.query<{ label: string; count: string }>(sql, params)).rows.map((r) => ({
      label: r.label,
      count: n(r.count),
    }));

  let referrers: Counted[] | null = null;
  let searches: Counted[] | null = null;
  let pages: Counted[] | null = null;
  let readers: Counted[] | null = null;
  let shareTargets: Counted[] | null = null;
  let feedFetches: number | null = null;
  if (who.all) {
    referrers = await sum(
      `SELECT dim AS label, sum(count) AS count FROM analytics_daily
       WHERE kind = 'view' AND dim <> '' AND day BETWEEN $1 AND $2 GROUP BY dim ORDER BY sum(count) DESC, dim LIMIT 10`,
      [...range],
    );
    searches = await sum(
      `SELECT key AS label, sum(count) AS count FROM analytics_daily
       WHERE kind = 'search' AND day BETWEEN $1 AND $2 GROUP BY key HAVING sum(count) >= $3
       ORDER BY sum(count) DESC, key LIMIT 20`,
      [...range, MIN_SEARCH_COUNT],
    );
    pages = await sum(
      `SELECT key AS label, sum(count) AS count FROM analytics_daily
       WHERE kind = 'view' AND key NOT LIKE 'article:%' AND day BETWEEN $1 AND $2
       GROUP BY key ORDER BY sum(count) DESC, key LIMIT 10`,
      [...range],
    );
    readers = await sum(
      `SELECT dim AS label, sum(count) AS count FROM analytics_daily
       WHERE kind = 'feed' AND day BETWEEN $1 AND $2 GROUP BY dim ORDER BY sum(count) DESC, dim`,
      [...range],
    );
    shareTargets = await sum(
      `SELECT dim AS label, sum(count) AS count FROM analytics_daily
       WHERE kind = 'share' AND day BETWEEN $1 AND $2 GROUP BY dim ORDER BY sum(count) DESC, dim`,
      [...range],
    );
    feedFetches = readers.reduce((t, r) => t + r.count, 0);
  }

  return {
    days,
    from: w.from,
    to: w.to,
    totals: { views: daily.reduce((t, d) => t + d.views, 0), shares, feedFetches },
    daily,
    articles,
    referrers,
    searches,
    pages,
    readers,
    shareTargets,
  };
}
