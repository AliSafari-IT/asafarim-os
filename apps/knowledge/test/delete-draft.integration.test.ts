/**
 * Deleting a never-published draft, against a real PostgreSQL: what goes, what stays, who may do it, and that the
 * database's own immutability for published articles holds (migration 9). Runs when KNOWLEDGE_TEST_DATABASE_URL
 * names a server where it may create a throwaway database, like the other integration suites.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import {
  createArticle,
  deleteDraftArticle,
  getStudioItem,
  publishRevision,
  saveDraft,
  withdrawArticle,
} from "../lib/content";
import { migrate } from "../lib/migrations";
import { PERMISSIONS, type Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;

const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const bob: Actor = { subject: "bob", permissions: grants("knowledge.author") };
const erin: Actor = { subject: "erin", permissions: grants("knowledge.editor") };
const member: Actor = { subject: "mallory", permissions: [] };
/** May see and publish alice's articles but not edit them: the only way to be "visible but not editable". */
const publisherOnly: Actor = { subject: "pat", permissions: [PERMISSIONS.create, PERMISSIONS.publishAny] };

const draft = (title: string, body = "") => ({ title, summary: "", body });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe.skipIf(!ADMIN_URL)("deleting a draft on PostgreSQL", () => {
  const dbName = `knowledge_test_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  const count = async (sql: string, params: unknown[] = []) =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    pool.on("error", () => undefined); // DROP DATABASE … WITH (FORCE) in afterAll closes idle clients
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

  /** A draft with everything that can hang off one: revisions, an autosave, a tag, a job, an old address, media. */
  async function richDraft(slug: string) {
    const a = ok(await createArticle(pool, alice, { slug, draft: draft("Rich draft", "one") }));
    const second = ok(
      await saveDraft(pool, alice, { id: a.id, expectedRevisionId: a.revisionId, draft: draft("Rich draft", "two") }),
    );
    await pool.query(
      `INSERT INTO draft_autosaves (item_id, author, base_revision_id, title, doc, body)
       VALUES ($1, 'alice', $2, 'unsaved', '{}'::jsonb, 'unsaved text')`,
      [a.id, second.revisionId],
    );
    await pool.query(`INSERT INTO tags (id, slug, name) VALUES ($1, $2, 'A tag') ON CONFLICT DO NOTHING`, [
      `tag-${slug}`,
      `tag-${slug}`,
    ]);
    await pool.query(`INSERT INTO item_tags (item_id, tag_id) VALUES ($1, $2)`, [a.id, `tag-${slug}`]);
    await pool.query(`INSERT INTO slug_redirects (old_slug, item_id) VALUES ($1, $2)`, [`old-${slug}`, a.id]);
    await pool.query(
      `INSERT INTO ai_jobs (id, actor, operation, item_id, base_revision_id, status, model, input_tokens, output_tokens)
       VALUES ($1, 'user:alice', 'improve', $2, $3, 'succeeded', 'fake-model', 300, 100)`,
      [`job-${slug}`, a.id, second.revisionId],
    );
    await pool.query(
      `INSERT INTO media_assets (id, owner_subject, kind, content_type, byte_size, filename, status, checked_at)
       VALUES ($1, 'alice', 'image', 'image/png', 10, 'a.png', 'ready', now())`,
      [`asset-${slug}`],
    );
    await pool.query(`INSERT INTO content_revision_media (revision_id, asset_id) VALUES ($1, $2)`, [
      second.revisionId,
      `asset-${slug}`,
    ]);
    return { id: a.id, first: a.revisionId, second: second.revisionId };
  }

  it("deletes a never-published draft with everything that hangs off it, and keeps the logs and the files", async () => {
    const d = await richDraft("to-delete");
    const auditBefore = await count("audit_events WHERE item_id = $1", [d.id]);
    expect(auditBefore).toBeGreaterThanOrEqual(2); // created, saved

    expect(await deleteDraftArticle(pool, alice, { id: d.id })).toEqual({ ok: true });

    expect(await count("content_items WHERE id = $1", [d.id])).toBe(0);
    expect(await count("content_revisions WHERE item_id = $1", [d.id])).toBe(0);
    expect(await count("content_revision_media WHERE revision_id = ANY($1)", [[d.first, d.second]])).toBe(0);
    expect(await count("draft_autosaves WHERE item_id = $1", [d.id])).toBe(0);
    expect(await count("item_tags WHERE item_id = $1", [d.id])).toBe(0);
    expect(await count("slug_redirects WHERE item_id = $1", [d.id])).toBe(0);
    expect(await getStudioItem(pool, alice, d.id)).toBeNull();

    // Kept: the audit trail (with a deleted event naming who), the AI job log, the uploaded file, the tag itself.
    const events = (
      await pool.query<{ action: string; actor: string }>(
        "SELECT action, actor FROM audit_events WHERE item_id = $1 ORDER BY id",
        [d.id],
      )
    ).rows;
    expect(events.length).toBe(auditBefore + 1);
    expect(events.at(-1)).toEqual({ action: "content.deleted", actor: "user:alice" });
    expect(await count("ai_jobs WHERE item_id = $1", [d.id])).toBe(1);
    expect(await count("media_assets WHERE id = $1", ["asset-to-delete"])).toBe(1);
    expect(await count("tags WHERE id = $1", ["tag-to-delete"])).toBe(1);
  });

  it("frees the slug, and a second delete finds nothing", async () => {
    const a = ok(await createArticle(pool, alice, { slug: "reusable", draft: draft("First") }));
    ok(await deleteDraftArticle(pool, alice, { id: a.id }));
    expect(await deleteDraftArticle(pool, alice, { id: a.id })).toEqual({ ok: false, error: "not_found" });
    const again = ok(await createArticle(pool, alice, { slug: "reusable", draft: draft("Second") }));
    expect(again.id).not.toBe(a.id);
  });

  it("refuses a published article and a withdrawn one, and leaves both exactly as they were", async () => {
    const pub = ok(await createArticle(pool, alice, { slug: "published-one", draft: draft("Published", "body") }));
    ok(await publishRevision(pool, alice, { id: pub.id, revisionId: pub.revisionId }));
    expect(await deleteDraftArticle(pool, alice, { id: pub.id })).toEqual({ ok: false, error: "not_deletable" });
    expect((await getStudioItem(pool, alice, pub.id))?.item.status).toBe("published");

    ok(await withdrawArticle(pool, alice, { id: pub.id }));
    expect(await deleteDraftArticle(pool, alice, { id: pub.id })).toEqual({ ok: false, error: "not_deletable" });
    expect((await getStudioItem(pool, alice, pub.id))?.item.status).toBe("withdrawn");
    expect(await count("content_revisions WHERE item_id = $1", [pub.id])).toBe(1);
    expect(await count("audit_events WHERE item_id = $1 AND action = 'content.deleted'", [pub.id])).toBe(0);
  });

  it("follows who may edit: owner and editors yes; others' drafts are not found; view-only is forbidden", async () => {
    const mine = ok(await createArticle(pool, alice, { slug: "alices", draft: draft("Alice's") }));
    expect(await deleteDraftArticle(pool, bob, { id: mine.id })).toEqual({ ok: false, error: "not_found" });
    expect(await deleteDraftArticle(pool, member, { id: mine.id })).toEqual({ ok: false, error: "not_found" });
    expect(await deleteDraftArticle(pool, publisherOnly, { id: mine.id })).toEqual({ ok: false, error: "forbidden" });
    expect(await count("content_items WHERE id = $1", [mine.id])).toBe(1);

    expect(await deleteDraftArticle(pool, erin, { id: mine.id })).toEqual({ ok: true }); // editor: edit.any
    expect(await count("content_items WHERE id = $1", [mine.id])).toBe(0);
    expect(await deleteDraftArticle(pool, alice, { id: "not-a-real-id" })).toEqual({ ok: false, error: "not_found" });
  });

  it("is all or nothing: a failure part way leaves the article intact", async () => {
    const d = await richDraft("atomic");
    // Make the very last step fail: an unrelated table with a foreign key to the article blocks DELETE FROM
    // content_items, after the revisions, autosave and links have already been deleted in the same transaction.
    await pool.query("CREATE TABLE atomic_blocker (item_id text REFERENCES content_items (id))");
    await pool.query("INSERT INTO atomic_blocker (item_id) VALUES ($1)", [d.id]);
    await expect(deleteDraftArticle(pool, alice, { id: d.id })).rejects.toThrow(/foreign key/i);
    expect(await count("content_items WHERE id = $1", [d.id])).toBe(1);
    expect(await count("content_revisions WHERE item_id = $1", [d.id])).toBe(2);
    expect(await count("draft_autosaves WHERE item_id = $1", [d.id])).toBe(1);
    expect(await count("item_tags WHERE item_id = $1", [d.id])).toBe(1);
    expect(await count("audit_events WHERE item_id = $1 AND action = 'content.deleted'", [d.id])).toBe(0);
    await pool.query("DROP TABLE atomic_blocker");
    expect(await deleteDraftArticle(pool, alice, { id: d.id })).toEqual({ ok: true }); // and it works once unblocked
  });

  describe("the database's own guard (migration 9)", () => {
    it("still refuses every update and every delete outside the delete flow", async () => {
      const a = ok(await createArticle(pool, alice, { slug: "guarded", draft: draft("Guarded") }));
      await expect(
        pool.query("UPDATE content_revisions SET body = 'tampered' WHERE id = $1", [a.revisionId]),
      ).rejects.toThrow(/immutable/);
      await expect(pool.query("DELETE FROM content_revisions WHERE id = $1", [a.revisionId])).rejects.toThrow(
        /immutable/,
      );
    });

    it("refuses a delete for a PUBLISHED article even when the transaction names it", async () => {
      const a = ok(await createArticle(pool, alice, { slug: "guarded-public", draft: draft("Public") }));
      ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('knowledge.deleting_draft', $1, true)", [a.id]);
        await expect(c.query("DELETE FROM content_revisions WHERE item_id = $1", [a.id])).rejects.toThrow(/immutable/);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
      expect(await count("content_revisions WHERE item_id = $1", [a.id])).toBe(1);
    });

    it("refuses a delete for a WITHDRAWN article, and for a different article than the one named", async () => {
      const w = ok(await createArticle(pool, alice, { slug: "guarded-withdrawn", draft: draft("W") }));
      ok(await publishRevision(pool, alice, { id: w.id, revisionId: w.revisionId }));
      ok(await withdrawArticle(pool, alice, { id: w.id }));
      const other = ok(await createArticle(pool, alice, { slug: "guarded-other", draft: draft("Other") }));
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('knowledge.deleting_draft', $1, true)", [w.id]);
        await expect(c.query("DELETE FROM content_revisions WHERE item_id = $1", [w.id])).rejects.toThrow(/immutable/);
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await c.query("SELECT set_config('knowledge.deleting_draft', $1, true)", [other.id]);
        await expect(c.query("DELETE FROM content_revisions WHERE item_id = $1", [w.id])).rejects.toThrow(/immutable/);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    });

    it("never allows an UPDATE, even for the named draft; and the name does not outlive its transaction", async () => {
      const a = ok(await createArticle(pool, alice, { slug: "guarded-update", draft: draft("U") }));
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('knowledge.deleting_draft', $1, true)", [a.id]);
        await expect(c.query("UPDATE content_revisions SET body = 'x' WHERE item_id = $1", [a.id])).rejects.toThrow(
          /immutable/,
        );
        await c.query("ROLLBACK");
        // A later transaction on the same connection has no name set: the delete is refused again.
        await c.query("BEGIN");
        await expect(c.query("DELETE FROM content_revisions WHERE item_id = $1", [a.id])).rejects.toThrow(/immutable/);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    });
  });
});
