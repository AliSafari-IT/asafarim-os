/**
 * Analytics against a real PostgreSQL (migration 11): the counts are right and safe to write concurrently, a share is
 * counted only for a published article from the site's own pages, what each kind of person may see in Insights, the
 * retention, and above all that the table can't hold personal data. Runs when KNOWLEDGE_TEST_DATABASE_URL names a
 * server where it may create a throwaway database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { createArticle, publishRevision, withdrawArticle } from "../lib/content";
import {
  getInsights,
  handleShareRequest,
  MIN_SEARCH_COUNT,
  purgeOldAnalytics,
  recordEvent,
  recordFeedFetch,
  recordShare,
  RETENTION_DAYS,
  SEARCH_RETENTION_DAYS,
  windowOf,
} from "../lib/analytics/store";
import { migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const bob: Actor = { subject: "bob", permissions: grants("knowledge.author") };

const TODAY = new Date("2026-11-27T10:00:00Z");
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000);

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const shareRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://learn.asafarim.site/api/public/analytics/event", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "user-agent": CHROME, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
  });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe.skipIf(!ADMIN_URL)("analytics on PostgreSQL", () => {
  const dbName = `knowledge_test_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  const total = async (kind: string, key: string, dim = "") =>
    Number(
      (
        await pool.query<{ n: string }>(
          "SELECT coalesce(sum(count), 0) AS n FROM analytics_daily WHERE kind = $1 AND key = $2 AND dim = $3",
          [kind, key, dim],
        )
      ).rows[0]!.n,
    );
  const rows = async () => (await pool.query("SELECT * FROM analytics_daily")).rowCount ?? 0;

  async function publish(actor: Actor, slug: string, title: string) {
    const a = ok(await createArticle(pool, actor, { slug, draft: { title, summary: "", body: "text" } }));
    ok(await publishRevision(pool, actor, { id: a.id, revisionId: a.revisionId }));
    return a.id;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    pool.on("error", () => undefined); // DROP DATABASE … WITH (FORCE) in afterAll closes idle clients
    const c = await pool.connect();
    try {
      await migrate(c);
    } finally {
      c.release();
    }
    await publish(alice, "alices-article", "Alice's article");
    await publish(alice, "alices-second", "Alice's second");
    await publish(bob, "bobs-article", "Bob's article");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  describe("the table", () => {
    it("has exactly the columns of a daily count, none of which can hold a person", async () => {
      const cols = (
        await pool.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_daily' ORDER BY ordinal_position",
        )
      ).rows.map((r) => r.column_name);
      expect(cols).toEqual(["day", "kind", "key", "dim", "count"]);
    });

    it("refuses an unknown kind, an empty or over-long key or label, and a negative count", async () => {
      const bad = (sql: string, params: unknown[]) =>
        expect(pool.query(sql, params)).rejects.toThrow(/check|constraint/i);
      const insert = "INSERT INTO analytics_daily (day, kind, key, dim, count) VALUES (now(), $1, $2, $3, $4)";
      await bad(insert, ["click", "k", "", 1]);
      await bad(insert, ["view", "", "", 1]);
      await bad(insert, ["view", "k".repeat(201), "", 1]);
      await bad(insert, ["view", "k", "d".repeat(101), 1]);
      await bad(insert, ["view", "k", "", -1]);
    });
  });

  describe("counting", () => {
    it("adds one per event, in the same row for the same day, kind, page and label", async () => {
      await recordEvent(pool, "view", "home", "", TODAY);
      await recordEvent(pool, "view", "home", "", TODAY);
      await recordEvent(pool, "view", "home", "", TODAY);
      expect(await total("view", "home")).toBe(3);
      expect((await pool.query("SELECT 1 FROM analytics_daily WHERE kind='view' AND key='home'")).rowCount).toBe(1);
    });

    it("keeps different days, pages, kinds and labels apart", async () => {
      await recordEvent(pool, "view", "page-a", "", TODAY);
      await recordEvent(pool, "view", "page-a", "", daysAgo(1));
      await recordEvent(pool, "view", "page-b", "", TODAY);
      await recordEvent(pool, "view", "page-a", "x.com", TODAY);
      await recordEvent(pool, "search", "page-a", "", TODAY);
      expect(await total("view", "page-a")).toBe(2);
      expect(await total("view", "page-a", "x.com")).toBe(1);
      expect(await total("view", "page-b")).toBe(1);
      expect(await total("search", "page-a")).toBe(1);
    });

    it("uses the UTC day: 23:59 UTC and 00:01 UTC are different days, whatever the server's zone", async () => {
      await recordEvent(pool, "view", "midnight", "", new Date("2026-11-26T23:59:59Z"));
      await recordEvent(pool, "view", "midnight", "", new Date("2026-11-27T00:00:01Z"));
      const days = (
        await pool.query<{ day: string }>(
          "SELECT to_char(day, 'YYYY-MM-DD') AS day FROM analytics_daily WHERE key = 'midnight' ORDER BY day",
        )
      ).rows.map((r) => r.day);
      expect(days).toEqual(["2026-11-26", "2026-11-27"]);
    });

    it("loses no count when many requests arrive at once", async () => {
      await Promise.all(Array.from({ length: 60 }, () => recordEvent(pool, "view", "busy", "", TODAY)));
      expect(await total("view", "busy")).toBe(60);
    });

    it("cuts an over-long key or label instead of failing the page", async () => {
      await recordEvent(pool, "view", "k".repeat(500), "d".repeat(500), TODAY);
      expect(await total("view", "k".repeat(200), "d".repeat(100))).toBe(1);
    });
  });

  describe("share clicks", () => {
    it("counts a click on a published article, per button", async () => {
      expect(await recordShare(pool, "alices-article", "linkedin", TODAY)).toBe(true);
      expect(await recordShare(pool, "alices-article", "linkedin", TODAY)).toBe(true);
      expect(await recordShare(pool, "alices-article", "copy", TODAY)).toBe(true);
      expect(await total("share", "article:alices-article", "linkedin")).toBe(2);
      expect(await total("share", "article:alices-article", "copy")).toBe(1);
    });

    it("ignores a draft, a withdrawn article and an address that doesn't exist: no row is made", async () => {
      const draft = ok(
        await createArticle(pool, alice, { slug: "a-draft", draft: { title: "Draft", summary: "", body: "x" } }),
      );
      const gone = await publish(alice, "was-public", "Was public");
      ok(await withdrawArticle(pool, alice, { id: gone }));
      const before = await rows();
      expect(draft.id).toBeTruthy();
      for (const slug of ["a-draft", "was-public", "no-such-article", "x'; DROP TABLE analytics_daily; --"]) {
        expect(await recordShare(pool, slug, "x", TODAY), slug).toBe(false);
      }
      expect(await rows()).toBe(before);
    });
  });

  describe("a click reported by the page's own script", () => {
    const click = (over: Record<string, unknown> = {}) => ({
      type: "share",
      slug: "bobs-article",
      target: "x",
      ...over,
    });

    it("is counted when it comes from the site itself", async () => {
      expect(await handleShareRequest(pool, shareRequest(click()), TODAY)).toBe(true);
      expect(await total("share", "article:bobs-article", "x")).toBe(1);
    });

    it("is accepted from a browser with no fetch metadata only when its Origin is this host", async () => {
      const bare = (origin: string | null) =>
        new Request("https://learn.asafarim.site/api/public/analytics/event", {
          method: "POST",
          body: JSON.stringify(click()),
          headers: { "user-agent": CHROME, host: "learn.asafarim.site", ...(origin ? { origin } : {}) },
        });
      expect(await handleShareRequest(pool, bare("https://learn.asafarim.site"), TODAY)).toBe(true);
      expect(await handleShareRequest(pool, bare("https://evil.example"), TODAY)).toBe(false);
      expect(await handleShareRequest(pool, bare(null), TODAY)).toBe(false);
      expect(await handleShareRequest(pool, bare("not a url"), TODAY)).toBe(false);
    });

    it("is ignored from another site, a bot, an opted-out browser, or with a bad body", async () => {
      const before = await total("share", "article:bobs-article", "x");
      const cases: [string, Request][] = [
        ["cross-site", shareRequest(click(), { "sec-fetch-site": "cross-site" })],
        ["same-site (a sibling subdomain)", shareRequest(click(), { "sec-fetch-site": "same-site" })],
        ["bot", shareRequest(click(), { "user-agent": "Googlebot/2.1" })],
        ["no user agent", shareRequest(click(), { "user-agent": "" })],
        ["Global Privacy Control", shareRequest(click(), { "sec-gpc": "1" })],
        ["Do Not Track", shareRequest(click(), { dnt: "1" })],
        ["not JSON", shareRequest("not json")],
        ["JSON that isn't an object", shareRequest("42")],
        ["null", shareRequest("null")],
        ["an oversized body", shareRequest(JSON.stringify({ ...click(), pad: "x".repeat(600) }))],
        ["a wrong type", shareRequest(click({ type: "view" }))],
        ["an unknown button", shareRequest(click({ target: "facebook" }))],
        ["a missing slug", shareRequest({ type: "share", target: "x" })],
        ["a slug that is not text", shareRequest(click({ slug: 5 }))],
        ["a very long slug", shareRequest(click({ slug: "a".repeat(200) }))],
        ["a draft", shareRequest(click({ slug: "a-draft" }))],
      ];
      for (const [name, request] of cases) expect(await handleShareRequest(pool, request, TODAY), name).toBe(false);
      expect(await total("share", "article:bobs-article", "x")).toBe(before);
    });
  });

  describe("feed fetches", () => {
    const ua = (value: string) => ({ get: (k: string) => (k.toLowerCase() === "user-agent" ? value : null) });

    it("counts by the reader's name, and not a crawler or script", async () => {
      await recordFeedFetch(pool, ua("Feedly/1.0 (+http://www.feedly.com/fetcher.html; 12 subscribers)"), TODAY);
      await recordFeedFetch(pool, ua("Feedly/1.0 (+http://www.feedly.com/fetcher.html; 13 subscribers)"), TODAY);
      await recordFeedFetch(pool, ua(CHROME), TODAY);
      await recordFeedFetch(pool, ua("Googlebot/2.1"), TODAY);
      await recordFeedFetch(pool, ua("curl/8.4.0"), TODAY);
      expect(await total("feed", "feed", "Feedly")).toBe(2);
      expect(await total("feed", "feed", "Browser")).toBe(1);
      expect(await total("feed", "feed", "Other")).toBe(0);
      expect((await pool.query("SELECT 1 FROM analytics_daily WHERE kind = 'feed'")).rowCount).toBe(2); // Feedly, Browser
    });
  });

  describe("no personal data reaches the table, whatever the request carries", () => {
    it("keeps no address, browser string, subscriber count or search text from the requests it saw", async () => {
      const UNIQUE_UA = "Mozilla/5.0 UniqueBrowserString-9f3a7c21 (X11; Linux x86_64)";
      const IP = "203.0.113.77";
      await handleShareRequest(
        pool,
        shareRequest(
          { type: "share", slug: "alices-article", target: "linkedin" },
          { "user-agent": UNIQUE_UA, "x-forwarded-for": IP, "x-real-ip": IP, cookie: "session=SECRET-COOKIE-123" },
        ),
        TODAY,
      );
      await recordFeedFetch(
        pool,
        { get: (k) => (k.toLowerCase() === "user-agent" ? `Feedly/1.0 (7654321 subscribers) ${IP}` : null) },
        TODAY,
      );
      const dump = JSON.stringify((await pool.query("SELECT * FROM analytics_daily")).rows);
      for (const secret of [IP, "UniqueBrowserString", "SECRET-COOKIE", "7654321", "x-forwarded-for"]) {
        expect(dump, secret).not.toContain(secret);
      }
    });
  });

  describe("retention", () => {
    it("deletes totals past their retention and search terms past theirs, and keeps what is recent", async () => {
      await recordEvent(pool, "view", "ancient", "", daysAgo(RETENTION_DAYS + 5));
      await recordEvent(pool, "view", "old-but-kept", "", daysAgo(RETENTION_DAYS - 5));
      await recordEvent(pool, "search", "ancient term", "", daysAgo(SEARCH_RETENTION_DAYS + 5));
      await recordEvent(pool, "search", "recent term", "", daysAgo(SEARCH_RETENTION_DAYS - 5));
      await recordEvent(pool, "feed", "feed", "OldReader", daysAgo(SEARCH_RETENTION_DAYS + 5)); // not a search: kept
      await purgeOldAnalytics(pool, TODAY);
      expect(await total("view", "ancient")).toBe(0);
      expect(await total("view", "old-but-kept")).toBe(1);
      expect(await total("search", "ancient term")).toBe(0);
      expect(await total("search", "recent term")).toBe(1);
      expect(await total("feed", "feed", "OldReader")).toBe(1);
    });
  });

  describe("what Insights shows", () => {
    // Its own window, months away from every other test's counts, so the totals below are only this block's.
    const NOW = new Date("2027-06-15T10:00:00Z");
    const ago = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    let seeded = false;
    async function seed() {
      if (seeded) return;
      seeded = true;
      // Views of three articles, a few pages, with referrers, spread over days.
      for (let i = 0; i < 5; i++)
        await recordEvent(pool, "view", "article:alices-article", i % 2 ? "x.com" : "", ago(i));
      for (let i = 0; i < 2; i++) await recordEvent(pool, "view", "article:alices-second", "", ago(3));
      for (let i = 0; i < 7; i++) await recordEvent(pool, "view", "article:bobs-article", "linkedin.com", ago(1));
      for (let i = 0; i < 4; i++) await recordEvent(pool, "view", "home", "google.com", ago(2));
      await recordEvent(pool, "view", "topic:web", "", ago(2));
      await recordEvent(pool, "view", "article:alices-article", "", ago(60)); // outside a 30-day window
      // Searches: one term often enough to show, one too rare.
      for (let i = 0; i < MIN_SEARCH_COUNT; i++) await recordEvent(pool, "search", "react hooks", "", ago(1));
      await recordEvent(pool, "search", "rare unique phrase", "", ago(1));
      await recordEvent(pool, "share", "article:bobs-article", "x", ago(1));
      for (let i = 0; i < 2; i++) await recordEvent(pool, "share", "article:alices-article", "linkedin", ago(1));
      await recordEvent(pool, "share", "article:alices-article", "copy", ago(2));
      await recordEvent(pool, "feed", "feed", "Feedly", ago(1));
    }

    it("windowOf lists every UTC day, oldest first, ending on the given day", () => {
      const w = windowOf(7, NOW);
      expect(w.list).toEqual([
        "2027-06-09",
        "2027-06-10",
        "2027-06-11",
        "2027-06-12",
        "2027-06-13",
        "2027-06-14",
        "2027-06-15",
      ]);
      expect(w.from).toBe("2027-06-09");
      expect(w.to).toBe("2027-06-15");
      // A late-evening UTC time is still that UTC day, and a month boundary is crossed correctly.
      expect(windowOf(3, new Date("2026-03-01T23:59:59Z")).list).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    });

    it("gives an editor the whole site: every article, the pages, referrers, searches, shares and the feed", async () => {
      await seed();
      const i = await getInsights(pool, { subject: "erin", all: true }, 30, NOW);
      expect(i.daily).toHaveLength(30);
      expect(i.daily.at(-1)!.day).toBe("2027-06-15");
      // 5 + 2 + 7 article views + 4 home + 1 topic, within 30 days (the 60-day-old view is outside)
      expect(i.totals.views).toBe(5 + 2 + 7 + 4 + 1 + 0);
      expect(i.articles.map((a) => [a.slug, a.views])).toEqual([
        ["bobs-article", 7],
        ["alices-article", 5],
        ["alices-second", 2],
      ]);
      expect(i.articles[0]!.title).toBe("Bob's article");
      expect(i.articles[0]!.shares).toEqual({ x: 1 });
      expect(i.articles[0]!.shareTotal).toBe(1);
      expect(i.referrers!.map((r) => [r.label, r.count])).toEqual([
        ["linkedin.com", 7],
        ["google.com", 4],
        ["x.com", 2],
      ]);
      expect(i.pages!.map((p) => p.label).sort()).toEqual(["home", "topic:web"]);
      expect(i.searches).toEqual([{ label: "react hooks", count: MIN_SEARCH_COUNT }]); // the rare one is not shown
      expect(i.shareTargets!.some((s) => s.label === "x")).toBe(true);
      expect(i.readers).toEqual([{ label: "Feedly", count: 1 }]);
      expect(i.totals.feedFetches).toBe(1);
      expect(i.totals.shares).toBe(4); // Bob's one and Alice's three
    });

    it("gives an author only their own articles, and none of the site-wide sections", async () => {
      await seed();
      const i = await getInsights(pool, { subject: "alice", all: false }, 30, NOW);
      expect(i.articles.map((a) => a.slug).sort()).toEqual(["alices-article", "alices-second"]);
      expect(i.articles.some((a) => a.slug === "bobs-article")).toBe(false);
      expect(i.totals.views).toBe(5 + 2); // not Bob's 7, not the home page
      expect(i.daily.reduce((t, d) => t + d.views, 0)).toBe(7);
      expect(i.referrers).toBeNull();
      expect(i.searches).toBeNull();
      expect(i.pages).toBeNull();
      expect(i.readers).toBeNull();
      expect(i.shareTargets).toBeNull();
      expect(i.totals.feedFetches).toBeNull();
      // Bob's share of his own article is not in Alice's total.
      expect(i.totals.shares).toBe(3); // her three share clicks (two LinkedIn, one copy)
    });

    it("shows nothing about another author's articles, even by their address", async () => {
      await seed();
      const i = await getInsights(pool, { subject: "someone-else", all: false }, 30, NOW);
      expect(i.articles).toEqual([]);
      expect(i.totals).toEqual({ views: 0, shares: 0, feedFetches: null });
    });

    it("limits the window and fills days with no views", async () => {
      await seed();
      const week = await getInsights(pool, { subject: "erin", all: true }, 7, NOW);
      expect(week.daily).toHaveLength(7);
      expect(week.daily.every((d) => Number.isInteger(d.views) && d.views >= 0)).toBe(true);
      const empty = await getInsights(pool, { subject: "erin", all: true }, 7, new Date("2030-01-01T00:00:00Z"));
      expect(empty.totals.views).toBe(0);
      expect(empty.articles).toEqual([]);
      expect(empty.daily.map((d) => d.views)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });
  });
});
