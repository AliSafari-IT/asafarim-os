/**
 * Topics, tags and public search on PostgreSQL (#357): the projection follows publish / withdraw / reclassify in
 * the same transaction, exact identifiers and misspelled titles are found, facets filter before ranking and
 * paging, and a 10 000-article set answers within a latency bound. KNOWLEDGE_TEST_DATABASE_URL as for the others.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { createArticle, publishRevision, saveDraft, withdrawArticle } from "../lib/content";
import { parseDoc, type Doc } from "../lib/doc";
import { backfillSearch, migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";
import { searchPublished, searchStudio, snippetParts } from "../lib/search";
import { classify, createTag, createTopic, resolveTags } from "../lib/taxonomy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const erin: Actor = { subject: "erin", permissions: grants("knowledge.editor") };

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

/** A structured document from headings (## ) and paragraphs; `code` spans in backticks. */
function doc(text: string): { doc: Doc; body: string } {
  const content = text
    .trim()
    .split("\n")
    .map((line) => {
      const h = /^## (.*)$/.exec(line);
      const inline = (s: string) =>
        s
          .split(/(`[^`]+`)/)
          .filter(Boolean)
          .map((p) =>
            p.startsWith("`")
              ? { type: "text", text: p.slice(1, -1), marks: [{ type: "code" }] }
              : { type: "text", text: p },
          );
      return h
        ? { type: "heading", attrs: { level: 2 }, content: inline(h[1]!) }
        : { type: "paragraph", content: inline(line) };
    });
  const p = parseDoc({ type: "doc", content });
  if (!p.ok) throw new Error(p.error);
  return { doc: p.doc, body: p.text };
}

describe.skipIf(!ADMIN_URL)("search on PostgreSQL", () => {
  const dbName = `knowledge_search_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  async function publish(actor: Actor, slug: string, title: string, text: string, summary = "") {
    const d = doc(text);
    const a = ok(await createArticle(pool, actor, { slug, draft: { title, summary, body: d.body, doc: d.doc } }));
    ok(await publishRevision(pool, actor, { id: a.id, revisionId: a.revisionId }));
    return a;
  }
  const slugs = (r: { items: { slug: string }[] }) => r.items.map((i) => i.slug);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    pool.on("error", () => undefined);
    const c = await pool.connect();
    try {
      await migrate(c);
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("curates topics and tags: editors only, two levels, aliases resolve, unknown tags are refused", async () => {
    expect(await createTopic(pool, alice, { slug: "web", name: "Web" })).toEqual({ ok: false, error: "forbidden" });
    ok(await createTopic(pool, erin, { slug: "web", name: "Web", description: "The web platform" }));
    ok(await createTopic(pool, erin, { slug: "react", name: "React", parentSlug: "web" }));
    expect(await createTopic(pool, erin, { slug: "hooks", name: "Hooks", parentSlug: "react" })).toEqual({
      ok: false,
      error: "topic_too_deep",
    });
    expect(await createTopic(pool, erin, { slug: "web", name: "Again" })).toEqual({ ok: false, error: "slug_taken" });
    ok(
      await createTag(pool, erin, {
        slug: "javascript",
        name: "JavaScript",
        kind: "technology",
        aliases: ["JS", "ecmascript"],
      }),
    );
    ok(await createTag(pool, erin, { slug: "csharp", name: "C#", kind: "technology", aliases: ["c-sharp"] }));
    ok(await createTag(pool, erin, { slug: "networking", name: "Networking", kind: "subject" }));
    expect(await createTag(pool, erin, { slug: "js", name: "JS", kind: "technology" })).toEqual({
      ok: false,
      error: "slug_taken",
    });
    expect(
      await createTag(pool, erin, { slug: "node", name: "Node", kind: "technology", aliases: ["ecmascript"] }),
    ).toEqual({
      ok: false,
      error: "alias_taken",
      detail: "ecmascript",
    });
    expect(
      await createTag(pool, erin, { slug: "long", name: "Long", kind: "subject", aliases: ["", "x".repeat(61)] }),
    ).toEqual({ ok: false, error: "invalid_alias", detail: "x".repeat(61) });
    const r = await resolveTags(pool, ["js", "C#", "Networking"]);
    expect(r.ok && r.ids.length).toBe(3);
    expect(await resolveTags(pool, ["js", "cobol"])).toEqual({ ok: false, error: "unknown_tag", key: "cobol" });
  });

  it("indexes only published articles, in the transaction that publishes, withdraws or reclassifies", async () => {
    const hooks = await publish(
      alice,
      "react-hooks",
      "Understanding React hooks",
      "Hooks let function components keep state.\n## The `useEffect` hook\nCall `useEffect(() => {}, [])` to run an effect after render.\n## Rules\nOnly call hooks at the top level.",
      "State and effects in function components",
    );
    const net = await publish(
      alice,
      "connection-reset",
      "Debugging connection resets",
      "Chrome shows ERR_CONNECTION_RESET when the peer closes the socket.\n## Causes\nA proxy, a firewall or TLS mismatches.",
    );
    await publish(
      alice,
      "csharp-records",
      "Records in C#",
      "C# 9 added records, immutable reference types.\n## With expressions\nUse `with` to copy.",
    );
    // A draft and a withdrawn article are never found, whatever they contain.
    ok(
      await createArticle(pool, alice, {
        slug: "secret-draft",
        draft: { title: "useEffect secrets", summary: "", body: "useEffect" },
      }),
    );
    const gone = await publish(alice, "withdrawn-hooks", "Old hooks article", "`useEffect` everywhere");
    ok(await withdrawArticle(pool, alice, { id: gone.id }));
    const projected = await pool.query("SELECT slug FROM search_documents ORDER BY slug");
    expect(projected.rows.map((r: { slug: string }) => r.slug)).toEqual([
      "connection-reset",
      "csharp-records",
      "react-hooks",
    ]);

    // Exact identifiers, whatever their case.
    expect(slugs(await searchPublished(pool, { q: "useEffect" }))).toEqual(["react-hooks"]);
    expect(slugs(await searchPublished(pool, { q: "err_connection_reset" }))).toEqual(["connection-reset"]);
    expect(slugs(await searchPublished(pool, { q: "C#" }))[0]).toBe("csharp-records");
    // Prefix of an identifier, and a misspelled title.
    expect(slugs(await searchPublished(pool, { q: "useEff" }))).toEqual(["react-hooks"]);
    expect(slugs(await searchPublished(pool, { q: "Undrestanding Raect hoks" }))).toEqual(["react-hooks"]);
    expect(slugs(await searchPublished(pool, { q: "debuging conection" }))).toContain("connection-reset");

    // The snippet comes from the section that matched, linked by its heading, with the match marked.
    const hit = (await searchPublished(pool, { q: "useEffect" })).items[0]!;
    expect(hit.section).toEqual({ anchor: "the-useeffect-hook", heading: "The useEffect hook" });
    expect(snippetParts(hit.snippet).some((p) => p.match && p.text.toLowerCase() === "useeffect")).toBe(true);

    // A new draft of a published article changes nothing public until it is published.
    const head = (await pool.query("SELECT draft_revision_id FROM content_items WHERE id = $1", [net.id])).rows[0];
    const v2 = doc("Now about ECONNRESET in Node.");
    ok(
      await saveDraft(pool, alice, {
        id: net.id,
        expectedRevisionId: head.draft_revision_id,
        draft: { title: "Debugging connection resets", summary: "", body: v2.body, doc: v2.doc },
      }),
    );
    expect(slugs(await searchPublished(pool, { q: "ECONNRESET" }))).toEqual([]);
    expect(slugs(await searchPublished(pool, { q: "ERR_CONNECTION_RESET" }))).toEqual(["connection-reset"]);

    // Two articles can share a tag created by an author in the editor.
    await Promise.all(
      [hooks, net].map(async (item) =>
        ok(
          await classify(pool, alice, {
            id: item.id,
            topicSlug: null,
            level: null,
            tags: ["Machine learning", "js"],
          }),
        ),
      ),
    );
    expect(slugs(await searchPublished(pool, { filters: { tag: "machine-learning" } })).sort()).toEqual([
      "connection-reset",
      "react-hooks",
    ]);
    ok(await classify(pool, alice, { id: net.id, topicSlug: null, level: null, tags: [] }));
    ok(await classify(pool, alice, { id: hooks.id, topicSlug: "react", level: "beginner", tags: ["js"] }));
    expect(slugs(await searchPublished(pool, { q: "hooks", filters: { technology: "javascript" } }))).toEqual([
      "react-hooks",
    ]);
    // A tag named by an alias in the query finds its articles.
    expect(slugs(await searchPublished(pool, { q: "ecmascript" }))).toEqual(["react-hooks"]);
    // A parent topic includes its children's articles.
    expect(slugs(await searchPublished(pool, { filters: { topic: "web" } }))).toEqual(["react-hooks"]);
    // Withdrawing removes it from the projection in the same transaction.
    ok(await withdrawArticle(pool, alice, { id: hooks.id }));
    expect(slugs(await searchPublished(pool, { q: "useEffect" }))).toEqual([]);
    expect(slugs(await searchPublished(pool, { filters: { topic: "web" } }))).toEqual([]);
    ok(await publishRevision(pool, alice, { id: hooks.id, revisionId: hooks.revisionId }));
    expect(slugs(await searchPublished(pool, { q: "useEffect" }))).toEqual(["react-hooks"]);
  });

  it("filters before ranking and pages without repeats", async () => {
    for (let i = 0; i < 7; i++) {
      const a = await publish(alice, `paging-${i}`, `Paging guide ${i}`, `Keyset paging with \`fetchPage${i}\`.`);
      ok(await classify(pool, alice, { id: a.id, topicSlug: null, level: i % 2 ? "advanced" : "beginner", tags: [] }));
    }
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page = await searchPublished(pool, { q: "paging", filters: { level: "advanced" }, after, limit: 2 });
      expect(page.items.every((h) => h.level === "advanced")).toBe(true);
      seen.push(...slugs(page));
      after = page.next;
    } while (after);
    // All three advanced ones, even though the beginner ones rank the same: filtered before the limit.
    expect(seen.sort()).toEqual(["paging-1", "paging-3", "paging-5"]);
    // A malformed cursor or facet is ignored, never an error.
    expect(
      (await searchPublished(pool, { q: "paging", after: "%%%", filters: { level: "expert", topic: "x'; --" } })).items
        .length,
    ).toBeGreaterThan(0);
  });

  it("searches the studio separately, drafts included, only what the person may see", async () => {
    ok(
      await createArticle(pool, erin, {
        slug: "erin-draft",
        draft: { title: "Erin's paging notes", summary: "", body: "" },
      }),
    );
    const mine = await searchStudio(pool, { subject: "alice", seesAll: false }, "secret");
    expect(mine.map((r) => r.slug)).toEqual(["secret-draft"]);
    expect((await searchStudio(pool, { subject: "alice", seesAll: false }, "erin")).length).toBe(0);
    expect((await searchStudio(pool, { subject: "erin", seesAll: true }, "secret")).map((r) => r.status)).toEqual([
      "draft",
    ]);
  });

  it("resolves a tag name only when one tag has it, and counts tags after resolving", async () => {
    ok(await createTag(pool, erin, { slug: "golang", name: "Go", kind: "technology" }));
    ok(await createTag(pool, erin, { slug: "go-game", name: "Go", kind: "subject" }));
    expect(await resolveTags(pool, ["Go"])).toEqual({ ok: false, error: "ambiguous_tag", key: "go" });
    const r = await resolveTags(pool, ["golang"]);
    expect(r.ok && r.ids.length).toBe(1);
    const a = await publish(alice, "board-games", "Board games", "Stones on a grid.");
    expect(await classify(pool, alice, { id: a.id, topicSlug: null, level: null, tags: ["Go"] })).toEqual({
      ok: false,
      error: "ambiguous_tag",
      detail: "go",
    });
    ok(await classify(pool, alice, { id: a.id, topicSlug: null, level: null, tags: ["go-game"] }));
    expect(slugs(await searchPublished(pool, { filters: { technology: "golang" } }))).toEqual([]);
  });

  it("finds words in list items, short and non-Latin queries, and links a section only when it matches", async () => {
    const list = parseDoc({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "What the stack needs." }] },
        {
          type: "bulletList",
          content: ["PostgreSQL", "Redis"].map((w) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: w }] }],
          })),
        },
      ],
    });
    if (!list.ok) throw new Error(list.error);
    const a = ok(
      await createArticle(pool, alice, {
        slug: "deploy-checklist",
        draft: { title: "Deployment checklist", summary: "", body: list.text, doc: list.doc },
      }),
    );
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    expect(slugs(await searchPublished(pool, { q: "Redis" }))).toEqual(["deploy-checklist"]);

    await publish(alice, "r-stats", "Statistics in R", "Data frames and plots.");
    expect(slugs(await searchPublished(pool, { q: "R" }))).toContain("r-stats");
    await publish(alice, "sorting-zh", "排序 算法", "快速 排序 和 归并 排序");
    expect(slugs(await searchPublished(pool, { q: "排序" }))).toEqual(["sorting-zh"]);

    // The title matches; no section says "vacuum", so the result has no section link and shows the summary.
    await publish(alice, "vacuum", "Vacuum tuning", "## Installation\nInstall the server first.", "Keep tables lean");
    const hit = (await searchPublished(pool, { q: "vacuum" })).items.find((h) => h.slug === "vacuum")!;
    expect(hit.section).toBeNull();
    expect(hit.snippet).toBe("Keep tables lean");
  });

  it("files an article under the language its author sets", async () => {
    const a = await publish(alice, "postgres-fr", "PostgreSQL en production", "Sauvegardes et réplication.");
    expect(slugs(await searchPublished(pool, { q: "réplication", filters: { language: "fr" } }))).toEqual([]);
    expect(await classify(pool, alice, { id: a.id, topicSlug: null, level: null, tags: [], language: "xx" })).toEqual({
      ok: false,
      error: "invalid_language",
    });
    ok(await classify(pool, alice, { id: a.id, topicSlug: null, level: null, tags: [], language: "fr" }));
    expect(slugs(await searchPublished(pool, { q: "réplication", filters: { language: "fr" } }))).toEqual([
      "postgres-fr",
    ]);
    expect(slugs(await searchPublished(pool, { q: "réplication", filters: { language: "en" } }))).toEqual([]);
  });

  it("backfills articles that were public before search existed, from the published revision", async () => {
    const a = await publish(alice, "legacy", "Legacy article", "Published before search.");
    ok(
      await saveDraft(pool, alice, {
        id: a.id,
        expectedRevisionId: a.revisionId,
        draft: { title: "Legacy article", summary: "", body: "Unpublished zeppelin draft." },
      }),
    );
    // As on an install upgraded from version 5: the projection is empty.
    await pool.query("DELETE FROM search_documents");
    expect(slugs(await searchPublished(pool, { q: "legacy" }))).toEqual([]);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await backfillSearch(c);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(slugs(await searchPublished(pool, { q: "legacy" }))).toEqual(["legacy"]);
    expect(slugs(await searchPublished(pool, { q: "zeppelin" }))).toEqual([]);
    expect(slugs(await searchPublished(pool, { q: "secret" }))).toEqual([]);
  });

  it("answers within the latency bound on 10 000 published articles (p95)", async () => {
    // Seeded straight into the projection: what search reads. One owner article carries every revision row.
    const owner = ok(
      await createArticle(pool, alice, { slug: "bench-owner", draft: { title: "Bench", summary: "", body: "" } }),
    );
    await pool.query(
      `INSERT INTO content_items (id, owner_subject, slug, draft_revision_id)
       SELECT 'bench-' || g, 'alice', 'bench-' || g, NULL FROM generate_series(1, 10000) g`,
    );
    await pool.query(
      `INSERT INTO content_revisions (id, item_id, number, format, title, body, author)
       SELECT 'bench-r-' || g, 'bench-' || g, 1, 'markdown', 'Article ' || g || ' about ' || (ARRAY['react','postgres','kubernetes','rust','networking'])[1 + g % 5],
              repeat('Some prose about systems and code. ', 40) || ' fn' || g || 'Handler', 'alice'
       FROM generate_series(1, 10000) g`,
    );
    await pool.query(
      `INSERT INTO search_documents (item_id, revision_id, slug, kind, language, level, title, summary, published_at, tsv)
       SELECT i.id, r.id, i.slug, 'article', 'en', (ARRAY['beginner','intermediate','advanced'])[1 + random_n % 3],
              r.title, '', now() - (g || ' minutes')::interval,
              setweight(to_tsvector('simple', r.title), 'A') || setweight(to_tsvector('simple', r.body), 'D')
       FROM generate_series(1, 10000) g
       JOIN content_items i ON i.id = 'bench-' || g JOIN content_revisions r ON r.id = 'bench-r-' || g,
       LATERAL (SELECT g AS random_n) x`,
    );
    await pool.query(
      `INSERT INTO search_terms (item_id, term) SELECT 'bench-' || g, 'fn' || g || 'handler' FROM generate_series(1, 10000) g`,
    );
    await pool.query(
      `INSERT INTO search_sections (item_id, position, anchor, heading, body, tsv)
       SELECT d.item_id, 0, NULL, '', r.body, to_tsvector('simple', r.body)
       FROM search_documents d JOIN content_revisions r ON r.id = d.revision_id WHERE d.item_id LIKE 'bench-%'`,
    );
    await pool.query("ANALYZE");
    expect(owner.id).toBeTruthy();
    const queries = [
      "postgres",
      "fn4242handler",
      "fn42",
      "kubernets articel",
      "systems code",
      "react",
      "rust networking",
    ];
    const times: number[] = [];
    for (let round = 0; round < 6; round++) {
      for (const q of queries) {
        const t = performance.now();
        await searchPublished(pool, { q, filters: round % 2 ? { level: "advanced" } : {} });
        times.push(performance.now() - t);
        if (process.env.SEARCH_BENCH_VERBOSE) console.log(q, round, (performance.now() - t).toFixed(1));
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(
      `search p95 over ${times.length} queries on 10k articles: ${p95.toFixed(1)} ms (median ${times[times.length >> 1]!.toFixed(1)} ms)`,
    );
    expect(p95).toBeLessThan(500);
    expect(slugs(await searchPublished(pool, { q: "fn4242Handler" }))).toEqual(["bench-4242"]);
  }, 120_000);
});
