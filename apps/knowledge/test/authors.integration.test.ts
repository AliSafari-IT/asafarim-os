/**
 * Bylines against a real PostgreSQL (migration 10): the display name an author's sign-in presented is kept only when
 * it is fit to show, an unchanged name writes nothing, and the public queries return the byline, topic, level and
 * reading time. Runs when KNOWLEDGE_TEST_DATABASE_URL names a server where it may create a throwaway database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { createArticle, getPublishedArticle, listPublished, publishRevision } from "../lib/content";
import { rememberAuthor } from "../lib/authors";
import { migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const bob: Actor = { subject: "bob", permissions: grants("knowledge.author") };

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe.skipIf(!ADMIN_URL)("bylines on PostgreSQL", () => {
  const dbName = `knowledge_test_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  const stored = async (subject: string) =>
    (
      await pool.query<{ display_name: string; updated_at: Date }>(
        "SELECT display_name, updated_at FROM authors WHERE subject = $1",
        [subject],
      )
    ).rows[0];

  async function publish(actor: Actor, slug: string, title: string, body: string) {
    const a = ok(await createArticle(pool, actor, { slug, draft: { title, summary: "", body } }));
    ok(await publishRevision(pool, actor, { id: a.id, revisionId: a.revisionId }));
    return a.id;
  }

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

  it("remembers a name, writes nothing when it is unchanged, and follows a rename", async () => {
    await rememberAuthor(pool, "alice", "Alice Archer");
    const first = await stored("alice");
    expect(first?.display_name).toBe("Alice Archer");

    await new Promise((r) => setTimeout(r, 20));
    await rememberAuthor(pool, "alice", "  Alice   Archer ");
    expect((await stored("alice"))?.updated_at).toEqual(first!.updated_at); // same name once tidied: no write

    await rememberAuthor(pool, "alice", "Alice Archer-Bell");
    const renamed = await stored("alice");
    expect(renamed?.display_name).toBe("Alice Archer-Bell");
    expect(renamed!.updated_at.getTime()).toBeGreaterThan(first!.updated_at.getTime());
  });

  it("never stores something that is not a name: an email address, nothing, invisible text", async () => {
    await rememberAuthor(pool, "mallory", "mallory@example.com");
    await rememberAuthor(pool, "mallory", "   ");
    await rememberAuthor(pool, "mallory", undefined);
    await rememberAuthor(pool, "mallory", "​‮");
    expect(await stored("mallory")).toBeUndefined();

    // A good name already kept is not replaced by a bad one later.
    await rememberAuthor(pool, "carol", "Carol Chen");
    await rememberAuthor(pool, "carol", "carol@example.com");
    expect((await stored("carol"))?.display_name).toBe("Carol Chen");
  });

  it("the table itself refuses an empty or over-long name", async () => {
    await expect(pool.query("INSERT INTO authors (subject, display_name) VALUES ('x1', '')")).rejects.toThrow(/check/i);
    await expect(
      pool.query("INSERT INTO authors (subject, display_name) VALUES ('x2', $1)", ["n".repeat(81)]),
    ).rejects.toThrow(/check/i);
  });

  it("puts the owner's name, reading time, topic and level on the published article and the list", async () => {
    await rememberAuthor(pool, "bob", "Bob Baker");
    const id = await publish(bob, "bylined", "Bylined", "word ".repeat(450));
    await pool.query("INSERT INTO topics (id, slug, name) VALUES ('t1', 'databases', 'Databases')");
    await pool.query("UPDATE content_items SET topic_id = 't1', level = 'advanced' WHERE id = $1", [id]);

    const one = await getPublishedArticle(pool, "bylined");
    expect(one).toMatchObject({
      authorName: "Bob Baker",
      readingMinutes: 3,
      topic: { slug: "databases", name: "Databases" },
      level: "advanced",
    });
    const listed = (await listPublished(pool, { limit: 50 })).items.find((a) => a.slug === "bylined");
    expect(listed).toMatchObject({ authorName: "Bob Baker", readingMinutes: 3, topic: { slug: "databases" } });
  });

  it("has no name for an author who never signed in since this existed, and no topic when none is set", async () => {
    await publish(alice, "unclassified", "Unclassified", "short");
    await pool.query("DELETE FROM authors WHERE subject = 'alice'");
    expect(await getPublishedArticle(pool, "unclassified")).toMatchObject({
      authorName: null,
      readingMinutes: 1,
      topic: null,
      level: null,
    });
  });

  it("shows a rename on articles published before it", async () => {
    await rememberAuthor(pool, "bob", "Robert Baker");
    expect((await getPublishedArticle(pool, "bylined"))?.authorName).toBe("Robert Baker");
  });

  it("does not list a draft or its author through the public queries", async () => {
    ok(
      await createArticle(pool, bob, {
        slug: "private-draft",
        draft: { title: "Private draft", summary: "", body: "x" },
      }),
    );
    expect(await getPublishedArticle(pool, "private-draft")).toBeNull();
    expect((await listPublished(pool, { limit: 50 })).items.map((a) => a.slug)).not.toContain("private-draft");
  });
});
