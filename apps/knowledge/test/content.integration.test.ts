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
    const c = await pool.connect();
    try {
      expect(await migrate(c)).toEqual([1]);
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
    expect((await listPublished(pool)).map((a) => a.slug)).not.toContain("secret-draft");
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
    expect(JSON.stringify(await listPublished(pool))).not.toContain("UNPUBLISHED");

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
    expect((await listPublished(pool)).map((x) => x.slug)).not.toContain("withdraw-me");
    expect((await getStudioItem(pool, alice, a.id))?.item.status).toBe("withdrawn");
    expect(await withdrawArticle(pool, alice, { id: a.id })).toEqual({ ok: false, error: "not_published" });

    ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    expect(await getPublishedArticle(pool, "withdraw-me")).not.toBeNull();
  });

  it("hides one author's articles from another, and lets an editor act on any", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "alice-only", draft: draft("Alice only") }));
    expect(await getStudioItem(pool, bob, a.id)).toBeNull();
    expect((await listStudioItems(pool, bob)).map((i) => i.id)).not.toContain(a.id);
    expect(
      await saveDraft(pool, bob, { id: a.id, expectedRevisionId: a.revisionId, draft: draft("Bob was here") }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await publishRevision(pool, bob, { id: a.id, revisionId: a.revisionId })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await withdrawArticle(pool, member, { id: a.id })).toEqual({ ok: false, error: "not_found" });

    expect((await listStudioItems(pool, erin)).map((i) => i.id)).toContain(a.id);
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
