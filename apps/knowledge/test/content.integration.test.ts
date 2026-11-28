/**
 * The Phase 0 slice against a real PostgreSQL (#354): migrations, drafts and conflicts, publishing a
 * specific revision, what guests can and can't read, withdrawal, and who may change whose article.
 * Set KNOWLEDGE_TEST_DATABASE_URL to an admin connection (CI does); each run creates and drops its own
 * database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import {
  createArticle,
  getPublishedArticle,
  getStudioItem,
  listPublished,
  listStudioItems,
  publishRevision,
  saveDraft,
  withdrawArticle,
} from "../lib/content";
import { migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;

const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const bob: Actor = { subject: "bob", permissions: grants("knowledge.author") };
const erin: Actor = { subject: "erin", permissions: grants("knowledge.editor") };
const member: Actor = { subject: "mallory", permissions: [] };

const draft = (title: string, body = "", summary = "") => ({ title, summary, body });

/** Every page of a list, following its cursors (what a reader paging to the end sees). */
async function allPublished(pool: pg.Pool) {
  const out = [];
  let after: string | null = null;
  do {
    const page = await listPublished(pool, { after, limit: 7 });
    out.push(...page.items);
    after = page.next;
  } while (after);
  return out;
}
async function allStudio(pool: pg.Pool, actor: Actor) {
  const out = [];
  let after: string | null = null;
  do {
    const page = await listStudioItems(pool, actor, { after, limit: 7 });
    out.push(...page.items);
    after = page.next;
  } while (after);
  return out;
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe.skipIf(!ADMIN_URL)("knowledge content on PostgreSQL", () => {
  const dbName = `knowledge_test_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    // DROP DATABASE … WITH (FORCE) in afterAll terminates connections the pool may still be closing;
    // that FATAL 57P01 arrives as an idle-client error, which is expected here and must not crash the run.
    pool.on("error", () => undefined);
    const c = await pool.connect();
    try {
      expect(await migrate(c)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(await migrate(c)).toEqual([]); // idempotent
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("keeps a new draft away from guests", async () => {
    const created = ok(
      await createArticle(pool, alice, { slug: "secret-draft", draft: draft("Secret draft", "DRAFT-ONLY") }),
    );
    expect(await getPublishedArticle(pool, "secret-draft")).toBeNull();
    expect((await allPublished(pool)).map((a) => a.slug)).not.toContain("secret-draft");
    const seen = await getStudioItem(pool, alice, created.id);
    expect(seen?.item.status).toBe("draft");
    expect(seen?.item.draft.body).toBe("DRAFT-ONLY");
  });

  it("refuses to create without the permission, and refuses a slug already taken", async () => {
    expect(await createArticle(pool, member, { slug: "nope", draft: draft("Nope") })).toEqual({
      ok: false,
      error: "forbidden",
    });
    ok(await createArticle(pool, alice, { slug: "taken", draft: draft("First") }));
    expect(await createArticle(pool, bob, { slug: "taken", draft: draft("Second") })).toEqual({
      ok: false,
      error: "slug_taken",
    });
  });

  it("saves new revisions and refuses a stale save without losing the newer one", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "concurrent", draft: draft("v1") }));
    const second = ok(await saveDraft(pool, alice, { id: a.id, expectedRevisionId: a.revisionId, draft: draft("v2") }));
    // A second tab still holding revision 1.
    const stale = await saveDraft(pool, alice, { id: a.id, expectedRevisionId: a.revisionId, draft: draft("v2b") });
    expect(stale).toEqual({ ok: false, error: "conflict", currentRevisionId: second.revisionId });
    const seen = await getStudioItem(pool, alice, a.id);
    expect(seen?.item.draft.title).toBe("v2");
    expect(seen?.revisions.map((r) => r.number)).toEqual([2, 1]);
  });

  it("publishes exactly the chosen revision; later saves stay private until published", async () => {
    const a = ok(
      await createArticle(pool, alice, { slug: "use-effect", draft: draft("useEffect", "first body", "About hooks") }),
    );
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    const v2 = ok(
      await saveDraft(pool, alice, {
        id: a.id,
        expectedRevisionId: a.revisionId,
        draft: draft("useEffect", "UNPUBLISHED"),
      }),
    );

    const pub = await getPublishedArticle(pool, "use-effect");
    expect(pub).toMatchObject({ title: "useEffect", body: "first body", summary: "About hooks", revisionNumber: 1 });
    expect(JSON.stringify(await allPublished(pool))).not.toContain("UNPUBLISHED");

    ok(await publishRevision(pool, alice, { id: a.id, revisionId: v2.revisionId }));
    expect((await getPublishedArticle(pool, "use-effect"))?.body).toBe("UNPUBLISHED");
    // And back to the older one: publishing names a revision, not "the latest".
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    expect((await getPublishedArticle(pool, "use-effect"))?.revisionNumber).toBe(1);
  });

  it("refuses to publish another article's revision", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "mine", draft: draft("Mine") }));
    const b = ok(await createArticle(pool, alice, { slug: "other", draft: draft("Other", "OTHER BODY") }));
    expect(await publishRevision(pool, alice, { id: a.id, revisionId: b.revisionId })).toEqual({
      ok: false,
      error: "unknown_revision",
    });
    expect(await getPublishedArticle(pool, "mine")).toBeNull();
  });

  it("withdraws at once, and can publish again", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "withdraw-me", draft: draft("Withdraw me") }));
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    expect(await getPublishedArticle(pool, "withdraw-me")).not.toBeNull();

    ok(await withdrawArticle(pool, alice, { id: a.id }));
    expect(await getPublishedArticle(pool, "withdraw-me")).toBeNull();
    expect((await allPublished(pool)).map((x) => x.slug)).not.toContain("withdraw-me");
    expect((await getStudioItem(pool, alice, a.id))?.item.status).toBe("withdrawn");
    expect(await withdrawArticle(pool, alice, { id: a.id })).toEqual({ ok: false, error: "not_published" });

    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    expect(await getPublishedArticle(pool, "withdraw-me")).not.toBeNull();
  });

  it("hides one author's articles from another, and lets an editor act on any", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "alice-only", draft: draft("Alice only") }));
    expect(await getStudioItem(pool, bob, a.id)).toBeNull();
    expect((await allStudio(pool, bob)).map((i) => i.id)).not.toContain(a.id);
    expect(
      await saveDraft(pool, bob, { id: a.id, expectedRevisionId: a.revisionId, draft: draft("Bob was here") }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await publishRevision(pool, bob, { id: a.id, revisionId: a.revisionId })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await withdrawArticle(pool, member, { id: a.id })).toEqual({ ok: false, error: "not_found" });

    expect((await allStudio(pool, erin)).map((i) => i.id)).toContain(a.id);
    const edited = ok(
      await saveDraft(pool, erin, { id: a.id, expectedRevisionId: a.revisionId, draft: draft("Edited by Erin") }),
    );
    ok(await publishRevision(pool, erin, { id: a.id, revisionId: edited.revisionId }));
    expect((await getPublishedArticle(pool, "alice-only"))?.title).toBe("Edited by Erin");
    ok(await withdrawArticle(pool, erin, { id: a.id }));
    expect(await getPublishedArticle(pool, "alice-only")).toBeNull();
  });

  it("keeps revisions immutable and pointers inside their own article", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "immutable", draft: draft("Immutable") }));
    await expect(
      pool.query("UPDATE content_revisions SET body = 'tampered' WHERE id = $1", [a.revisionId]),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM content_revisions WHERE id = $1", [a.revisionId])).rejects.toThrow(
      /immutable/,
    );
    const b = ok(await createArticle(pool, alice, { slug: "immutable-2", draft: draft("Other") }));
    await expect(
      pool.query("UPDATE content_items SET published_revision_id = $2, published_at = now() WHERE id = $1", [
        a.id,
        b.revisionId,
      ]),
    ).rejects.toThrow(/foreign key/);
  });

  it("pages through 51 revisions: revision 1 stays reachable and publishable; the published one is always known", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "many-revisions", draft: draft("r1", "first") }));
    const first = a.revisionId;
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: first }));
    let head = first;
    for (let n = 2; n <= 51; n++) {
      head = ok(await saveDraft(pool, alice, { id: a.id, expectedRevisionId: head, draft: draft(`r${n}`) })).revisionId;
    }
    const page1 = await getStudioItem(pool, alice, a.id);
    expect(page1?.revisions.map((r) => r.number)).toEqual(Array.from({ length: 30 }, (_, i) => 51 - i));
    expect(page1?.published?.number).toBe(1); // not on this page, still identified
    expect(page1?.olderBefore).toBe(22);
    const page2 = await getStudioItem(pool, alice, a.id, { before: page1!.olderBefore });
    expect(page2?.revisions.map((r) => r.number)).toEqual(Array.from({ length: 21 }, (_, i) => 21 - i));
    expect(page2?.olderBefore).toBeNull();
    const r1 = page2!.revisions.at(-1)!;
    expect(r1.id).toBe(first);
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: page1!.revisions[0]!.id }));
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: r1.id }));
    expect((await getPublishedArticle(pool, "many-revisions"))?.revisionNumber).toBe(1);
  });

  it("pages through 55 published articles: every one is listed once, newest first, with no repeats", async () => {
    const before = new Set((await allPublished(pool)).map((x) => x.slug));
    for (let n = 0; n < 55; n++) {
      const c = ok(await createArticle(pool, bob, { slug: `bulk-${n}`, draft: draft(`Bulk ${n}`) }));
      ok(await publishRevision(pool, bob, { id: c.id, revisionId: c.revisionId }));
    }
    const all = await allPublished(pool);
    const slugs = all.map((x) => x.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (let n = 0; n < 55; n++) expect(slugs).toContain(`bulk-${n}`);
    expect(slugs.length).toBe(before.size + 55);
    const times = all.map((x) => x.publishedAt.getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    const first = await listPublished(pool);
    expect(first.items).toHaveLength(20);
    expect(first.next).not.toBeNull();
    // The studio pages too: bob sees all 55 of his, once each.
    const mine = (await allStudio(pool, bob)).map((i) => i.slug).filter((x) => x.startsWith("bulk-"));
    expect(new Set(mine).size).toBe(55);
  });

  it("ignores a cursor that doesn't decode (first page), and never treats it as SQL", async () => {
    for (const bad of [
      "",
      "%%%",
      "bm90LWEtY3Vyc29y",
      Buffer.from("x'; DROP TABLE content_items; --|y").toString("base64url"),
    ]) {
      const page = await listPublished(pool, { after: bad, limit: 3 });
      expect(page.items).toHaveLength(3);
    }
  });

  it("stores structured revisions next to Markdown ones, and publishes either (#356)", async () => {
    const { parseDoc } = await import("../lib/doc");
    const md = ok(await createArticle(pool, alice, { slug: "markdown-first", draft: draft("Old", "# Markdown body") }));
    const parsed = parseDoc({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Structured body" }] }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const v2 = ok(
      await saveDraft(pool, alice, {
        id: md.id,
        expectedRevisionId: md.revisionId,
        draft: { title: "New", summary: "", body: parsed.text, doc: parsed.doc },
      }),
    );
    const seen = await getStudioItem(pool, alice, md.id);
    expect(seen?.item.draft).toMatchObject({ format: "tiptap", body: "Structured body", doc: parsed.doc });
    expect(seen?.revisions.at(-1)).toMatchObject({ format: "markdown", doc: null, body: "# Markdown body" });

    ok(await publishRevision(pool, alice, { id: md.id, revisionId: md.revisionId }));
    expect(await getPublishedArticle(pool, "markdown-first")).toMatchObject({ format: "markdown", doc: null });
    ok(await publishRevision(pool, alice, { id: md.id, revisionId: v2.revisionId }));
    expect(await getPublishedArticle(pool, "markdown-first")).toMatchObject({ format: "tiptap", doc: parsed.doc });

    // The database refuses a structured revision without its document, or a Markdown one with one.
    await expect(
      pool.query(
        `INSERT INTO content_revisions (id, item_id, number, format, title, author) VALUES (gen_random_uuid()::text, $1, 99, 'tiptap', 't', 'alice')`,
        [md.id],
      ),
    ).rejects.toThrow(/content_revisions_doc_matches_format/);
  });

  it("autosaves without making revisions, keeps work through a conflict, and shows it for comparison (#372)", async () => {
    const { autosaveDraft, getAutosave, discardAutosave, getRevision } = await import("../lib/content");
    const { parseDoc } = await import("../lib/doc");
    const docOf = (text: string) => {
      const p = parseDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
      if (!p.ok) throw new Error(p.error);
      return p;
    };
    const a = ok(await createArticle(pool, alice, { slug: "autosaved", draft: draft("Autosaved", "v1") }));
    const mine = docOf("alice's unsaved line");
    const first = ok(
      await autosaveDraft(pool, alice, {
        id: a.id,
        baseRevisionId: a.revisionId,
        draft: { title: "Autosaved", summary: "", body: mine.text, doc: mine.doc },
      }),
    );
    expect(first.conflict).toBeNull();
    // An autosave is not a revision, and is only the author's own.
    expect((await getStudioItem(pool, alice, a.id))?.revisions).toHaveLength(1);
    expect(await getAutosave(pool, alice, a.id)).toMatchObject({ baseNumber: 1, body: "alice's unsaved line" });
    expect(await getAutosave(pool, erin, a.id)).toBeNull();
    // Someone who can't edit the article can't autosave to it either.
    expect(
      await autosaveDraft(pool, bob, {
        id: a.id,
        baseRevisionId: a.revisionId,
        draft: { title: "x", summary: "", body: mine.text, doc: mine.doc },
      }),
    ).toEqual({ ok: false, error: "not_found" });
    // A base revision from another article is refused.
    const other = ok(await createArticle(pool, alice, { slug: "autosave-other", draft: draft("Other") }));
    expect(
      await autosaveDraft(pool, alice, {
        id: a.id,
        baseRevisionId: other.revisionId,
        draft: { title: "x", summary: "", body: mine.text, doc: mine.doc },
      }),
    ).toEqual({ ok: false, error: "unknown_revision" });

    // An editor saves a newer revision meanwhile. Alice's next autosave is still kept, and reports the conflict.
    const v2 = ok(
      await saveDraft(pool, erin, {
        id: a.id,
        expectedRevisionId: a.revisionId,
        draft: draft("Autosaved", "erin's v2"),
      }),
    );
    const later = docOf("alice's unsaved line, longer");
    const second = ok(
      await autosaveDraft(pool, alice, {
        id: a.id,
        baseRevisionId: a.revisionId,
        draft: { title: "Autosaved", summary: "", body: later.text, doc: later.doc },
      }),
    );
    expect(second.conflict).toBe(v2.revisionId);
    expect(await getAutosave(pool, alice, a.id)).toMatchObject({
      baseRevisionId: a.revisionId,
      body: "alice's unsaved line, longer",
    });
    // Her explicit save on the old base is refused (nothing overwritten), and the autosave survives it.
    expect(
      await saveDraft(pool, alice, { id: a.id, expectedRevisionId: a.revisionId, draft: draft("Autosaved", "x") }),
    ).toEqual({ ok: false, error: "conflict", currentRevisionId: v2.revisionId });
    expect(await getAutosave(pool, alice, a.id)).not.toBeNull();
    // Both revisions can be read back for the comparison; a revision number that doesn't exist can't.
    expect((await getRevision(pool, alice, a.id, 2))?.revision.body).toBe("erin's v2");
    expect(await getRevision(pool, alice, a.id, 9)).toBeNull();
    expect(await getRevision(pool, bob, a.id, 1)).toBeNull();

    // Once she saves on top of the newest revision, the autosave is gone.
    ok(
      await saveDraft(pool, alice, {
        id: a.id,
        expectedRevisionId: v2.revisionId,
        draft: draft("Autosaved", "merged"),
      }),
    );
    expect(await getAutosave(pool, alice, a.id)).toBeNull();
    // Discard removes only the caller's own.
    ok(
      await autosaveDraft(pool, alice, {
        id: other.id,
        baseRevisionId: other.revisionId,
        draft: { title: "Other", summary: "", body: mine.text, doc: mine.doc },
      }),
    );
    await discardAutosave(pool, erin, other.id);
    expect(await getAutosave(pool, alice, other.id)).not.toBeNull();
    await discardAutosave(pool, alice, other.id);
    expect(await getAutosave(pool, alice, other.id)).toBeNull();
  });

  it("changes slugs with one-hop redirects for published articles, never chains or cycles (#372)", async () => {
    const { changeSlug, resolveSlugRedirect } = await import("../lib/content");
    const a = ok(await createArticle(pool, alice, { slug: "slug-one", draft: draft("Slugs") }));
    // A never-published draft just moves: no redirect.
    expect(await changeSlug(pool, alice, { id: a.id, slug: "slug-draft" })).toMatchObject({ ok: true });
    expect(await resolveSlugRedirect(pool, "slug-one")).toBeNull();
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    // Published: the old address redirects to the article's current one, in one hop, however often it moves.
    ok(await changeSlug(pool, alice, { id: a.id, slug: "slug-two" }));
    ok(await changeSlug(pool, alice, { id: a.id, slug: "slug-three" }));
    expect(await resolveSlugRedirect(pool, "slug-draft")).toBe("slug-three");
    expect(await resolveSlugRedirect(pool, "slug-two")).toBe("slug-three");
    expect(await getPublishedArticle(pool, "slug-two")).toBeNull();
    expect(await getPublishedArticle(pool, "slug-three")).toMatchObject({ title: "Slugs" });
    // Taking back an old slug removes its redirect: no cycle, and the current slug is never a redirect.
    ok(await changeSlug(pool, alice, { id: a.id, slug: "slug-two" }));
    expect(await resolveSlugRedirect(pool, "slug-two")).toBeNull();
    expect(await resolveSlugRedirect(pool, "slug-three")).toBe("slug-two");
    const redirects = await pool.query("SELECT old_slug FROM slug_redirects WHERE item_id = $1 ORDER BY old_slug", [
      a.id,
    ]);
    expect(redirects.rows.map((r: { old_slug: string }) => r.old_slug)).toEqual(["slug-draft", "slug-three"]);

    // Another article can't take a current slug or an old one, at creation or by a change.
    const b = ok(await createArticle(pool, bob, { slug: "slug-bob", draft: draft("Bob's") }));
    expect(await changeSlug(pool, bob, { id: b.id, slug: "slug-two" })).toEqual({ ok: false, error: "slug_taken" });
    expect(await changeSlug(pool, bob, { id: b.id, slug: "slug-three" })).toEqual({ ok: false, error: "slug_taken" });
    expect(await createArticle(pool, bob, { slug: "slug-draft", draft: draft("x") })).toEqual({
      ok: false,
      error: "slug_taken",
    });
    // Only someone who may edit (draft) or publish (once public) moves an article; others don't see it at all.
    expect(await changeSlug(pool, bob, { id: a.id, slug: "slug-x" })).toEqual({ ok: false, error: "not_found" });
    const editOnly: Actor = {
      subject: "alice",
      permissions: alice.permissions.filter((p) => p !== "knowledge.content.publish.own"),
    };
    expect(await changeSlug(pool, editOnly, { id: a.id, slug: "slug-x" })).toEqual({ ok: false, error: "forbidden" });

    // Withdrawn: the redirect stays recorded but leads nowhere a guest can see; republished, it works again.
    ok(await withdrawArticle(pool, alice, { id: a.id }));
    expect(await resolveSlugRedirect(pool, "slug-three")).toBeNull();
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    expect(await resolveSlugRedirect(pool, "slug-three")).toBe("slug-two");
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE item_id = $1 AND action = 'content.slug_changed'",
      [a.id],
    );
    expect(audit.rows[0].n).toBe(4);
  });

  it("runs AI operations as proposals within the budgets, logging no text (#360)", async () => {
    const { runAiOperation, reservationFor } = await import("../lib/ai/service");
    const { AiError } = await import("../lib/ai/provider");
    const writer: Actor = { subject: "ai-writer", permissions: [...grants("knowledge.author")] };
    const a = ok(await createArticle(pool, writer, { slug: "ai-article", draft: draft("AI", "SECRET DRAFT TEXT") }));
    let calls = 0;
    const provider = {
      provider: "fake",
      model: "fake-model",
      async countInput() {
        return 1000;
      },
      async generate() {
        calls++;
        return {
          answer: { text: "Improved SECRET ANSWER" },
          usage: { inputTokens: 300, outputTokens: 100 },
          model: "fake-model",
        };
      },
    };
    const caps = { monthlyTokenCap: 1_000_000, authorMonthlyTokenCap: 20_000 };
    const input = { op: "improve" as const, selection: "SECRET DRAFT TEXT", instruction: "shorter" };
    const r = await runAiOperation(pool, { provider, caps }, writer, {
      itemId: a.id,
      baseRevisionId: a.revisionId,
      input,
    });
    expect(r).toEqual({ ok: true, proposal: { kind: "text", text: "Improved SECRET ANSWER" }, model: "fake-model" });
    // The draft is unchanged: a proposal is not a save.
    expect((await getStudioItem(pool, writer, a.id))?.revisions).toHaveLength(1);
    // The reservation settled to the 400 tokens used, for the publication and the author.
    const usage = await pool.query("SELECT subject, reserved::int, used::int FROM ai_usage ORDER BY subject");
    expect(usage.rows).toEqual([
      { subject: "*", reserved: 0, used: 400 },
      { subject: "ai-writer", reserved: 0, used: 400 },
    ]);
    const jobs = await pool.query("SELECT * FROM ai_jobs");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({
      actor: "user:ai-writer",
      operation: "improve",
      status: "succeeded",
      input_tokens: 300,
    });
    expect(JSON.stringify(jobs.rows)).not.toMatch(/SECRET/);

    // Another author's article, or no AI permission: refused before any call.
    const other = ok(await createArticle(pool, bob, { slug: "bob-ai", draft: draft("Bob") }));
    expect(
      await runAiOperation(pool, { provider, caps }, writer, {
        itemId: other.id,
        baseRevisionId: other.revisionId,
        input,
      }),
    ).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await runAiOperation(pool, { provider, caps }, writer, { itemId: a.id, baseRevisionId: other.revisionId, input }),
    ).toEqual({ ok: false, error: "ai_stale_proposal" });
    expect((await pool.query("SELECT id FROM ai_jobs")).rowCount).toBe(1);
    const noAi: Actor = {
      subject: "ai-writer",
      permissions: writer.permissions.filter((x) => x !== "knowledge.ai.use"),
    };
    expect(
      await runAiOperation(pool, { provider, caps }, noAi, { itemId: a.id, baseRevisionId: a.revisionId, input }),
    ).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(calls).toBe(1);

    // The author's cap: concurrent requests can't reserve past it (each reserves ~7 000 tokens; 20 000 allows 2).
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        runAiOperation(pool, { provider, caps }, writer, { itemId: a.id, baseRevisionId: a.revisionId, input }),
      ),
    );
    const okCount = results.filter((x) => x.ok).length;
    expect(okCount).toBeGreaterThan(0);
    expect(results.filter((x) => !x.ok).every((x) => !x.ok && x.error === "ai_author_budget")).toBe(true);
    const after = await pool.query("SELECT (reserved + used)::int AS spent FROM ai_usage WHERE subject = 'ai-writer'");
    expect(after.rows[0].spent).toBeLessThanOrEqual(caps.authorMonthlyTokenCap);

    // A failing provider costs only what the API reported, and the draft is untouched.
    const failing = {
      ...provider,
      async generate(): Promise<never> {
        throw new AiError("refused", { inputTokens: 50, outputTokens: 0 });
      },
    };
    const before = (await pool.query("SELECT used::int FROM ai_usage WHERE subject = '*'")).rows[0].used;
    expect(
      await runAiOperation(pool, { provider: failing, caps: { ...caps, authorMonthlyTokenCap: 1_000_000 } }, writer, {
        itemId: a.id,
        baseRevisionId: a.revisionId,
        input,
      }),
    ).toEqual({ ok: false, error: "ai_refused" });
    expect((await pool.query("SELECT used::int, reserved::int FROM ai_usage WHERE subject = '*'")).rows[0]).toEqual({
      used: before + 50,
      reserved: 0,
    });
    const unreported = {
      ...provider,
      async generate(): Promise<never> {
        throw new AiError("timeout");
      },
    };
    const invoke = (p: typeof provider) =>
      runAiOperation(pool, { provider: p, caps }, writer, { itemId: a.id, baseRevisionId: a.revisionId, input });
    expect(await invoke(unreported)).toEqual({ ok: false, error: "ai_timeout" });
    const spent = async () => (await pool.query("SELECT used::int FROM ai_usage WHERE subject = '*'")).rows[0].used;
    // No usage reported: the whole reservation (counted input + margin + max output) is charged.
    const whole = reservationFor(1000, 6000);
    expect(await spent()).toBe(before + 50 + whole);
    // Force the success log insert to fail after a billable generation.
    await pool.query(
      "ALTER TABLE ai_jobs ADD CONSTRAINT test_fail_success_log CHECK (status <> 'succeeded') NOT VALID",
    );
    try {
      expect(await invoke(provider)).toEqual({ ok: false, error: "ai_unavailable" });
      expect(await spent()).toBe(before + 50 + whole + 400);
    } finally {
      await pool.query("ALTER TABLE ai_jobs DROP CONSTRAINT test_fail_success_log");
    }
  });

  it("settles once and charges expired reservations conservatively", async () => {
    const { reserve, settle, reconcile } = await import("../lib/ai/budget");
    const caps = { monthlyTokenCap: 1000, authorMonthlyTokenCap: 1000 };
    const now = new Date("2001-01-01Z");
    const a = ok(await reserve(pool, "ledger", 400, caps, now));
    const b = ok(await reserve(pool, "ledger", 500, caps, now));
    await Promise.all([settle(pool, a.id, 100), settle(pool, a.id, 100)]);
    await pool.query("UPDATE ai_reservations SET created_at = now() - interval '2 hours' WHERE id=$1", [b.id]);
    await reconcile(pool);
    await reconcile(pool);
    expect((await pool.query("SELECT reserved::int, used::int FROM ai_usage WHERE month='2001-01'")).rows).toEqual([
      { reserved: 0, used: 600 },
      { reserved: 0, used: 600 },
    ]);
  });

  it("records who did what, without the text", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "audited", draft: draft("Audited", "PRIVATE TEXT") }));
    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    ok(await withdrawArticle(pool, alice, { id: a.id }));
    const { rows } = await pool.query("SELECT actor, action FROM audit_events WHERE item_id = $1 ORDER BY id", [a.id]);
    expect(rows).toEqual([
      { actor: "user:alice", action: "content.created" },
      { actor: "user:alice", action: "content.published" },
      { actor: "user:alice", action: "content.withdrawn" },
    ]);
    const all = await pool.query("SELECT * FROM audit_events");
    expect(JSON.stringify(all.rows)).not.toContain("PRIVATE TEXT");
  });
});
