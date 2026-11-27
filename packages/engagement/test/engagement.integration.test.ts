/**
 * Runs against a real Postgres (ENGAGEMENT_TEST_DATABASE_URL, e.g. postgres://postgres:pw@127.0.0.1:5432/engagement_test)
 * in a throwaway schema, and, for the Redis limiter, a real Redis (ENGAGEMENT_TEST_REDIS_URL). Skipped without them.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEngagementHandlers,
  createEngagementService,
  createMemoryRateLimiter,
  createRedisRateLimiter,
  EngagementError,
  migrateEngagement,
  type EngagementUser,
  type OnCountChange,
  type SessionUser,
} from "../src/index.ts";

const DATABASE_URL = process.env.ENGAGEMENT_TEST_DATABASE_URL;
const REDIS_URL = process.env.ENGAGEMENT_TEST_REDIS_URL;
const SALT = "integration-test-salt-0123456789";

const schemaName = () => `eng_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

async function schemaPool(admin: pg.Pool, schema: string, max = 10): Promise<pg.Pool> {
  await admin.query(`CREATE SCHEMA ${schema}`);
  return new pg.Pool({ connectionString: DATABASE_URL, max, options: `-c search_path=${schema}` });
}

describe.skipIf(!DATABASE_URL)("engagement (Postgres)", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  const schema = schemaName();
  const extraSchemas: string[] = [];

  // The brief's rollup pattern, as the host app (knowledge) registers it: lesson -> module -> course.
  const rollup: OnCountChange = async (type, id, metric, delta, tx) => {
    if (type !== "lesson") return;
    const col = metric === "likes" ? "likes_count" : "comments_count";
    const lesson = await tx.query(`UPDATE lessons SET ${col} = ${col} + $1 WHERE id = $2 RETURNING module_id`, [
      delta,
      id,
    ]);
    const moduleId = lesson.rows[0]?.module_id as string | undefined;
    if (!moduleId) throw new Error(`unknown lesson ${id}`);
    const mod = await tx.query(`UPDATE modules SET ${col} = ${col} + $1 WHERE id = $2 RETURNING course_id`, [
      delta,
      moduleId,
    ]);
    await tx.query(`UPDATE courses SET ${col} = ${col} + $1 WHERE id = $2`, [delta, mod.rows[0]!.course_id]);
  };

  const service = () => createEngagementService({ pool, onCountChange: rollup });
  const lesson = { entityType: "lesson", entityId: "l1" };
  const lesson2 = { entityType: "lesson", entityId: "l2" };
  const alice: EngagementUser = {
    id: "user-alice",
    name: "Alice",
    avatarUrl: "https://example.com/a.png",
    role: "instructor",
  };
  const bob: EngagementUser = { id: "user-bob", name: "Bob" };

  async function counts() {
    const q = async (t: string, id: string) =>
      (await pool.query(`SELECT likes_count AS l, comments_count AS c FROM ${t} WHERE id = $1`, [id])).rows[0] as {
        l: number;
        c: number;
      };
    return {
      l1: await q("lessons", "l1"),
      l2: await q("lessons", "l2"),
      m1: await q("modules", "m1"),
      c1: await q("courses", "c1"),
    };
  }
  const rows = async (table: string, where = "true") =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0]!.n);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    pool = await schemaPool(admin, schema);
    const c = await pool.connect();
    try {
      await migrateEngagement(c);
    } finally {
      c.release();
    }
    await pool.query(`
      CREATE TABLE courses (id text PRIMARY KEY, likes_count int NOT NULL DEFAULT 0, comments_count int NOT NULL DEFAULT 0);
      CREATE TABLE modules (id text PRIMARY KEY, course_id text NOT NULL REFERENCES courses (id),
        likes_count int NOT NULL DEFAULT 0, comments_count int NOT NULL DEFAULT 0);
      CREATE TABLE lessons (id text PRIMARY KEY, module_id text NOT NULL REFERENCES modules (id),
        likes_count int NOT NULL DEFAULT 0, comments_count int NOT NULL DEFAULT 0);
      INSERT INTO courses (id) VALUES ('c1');
      INSERT INTO modules (id, course_id) VALUES ('m1', 'c1');
      INSERT INTO lessons (id, module_id) VALUES ('l1', 'm1'), ('l2', 'm1');
    `);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE engagement_likes, engagement_comments");
    await pool.query("UPDATE lessons SET likes_count = 0, comments_count = 0");
    await pool.query("UPDATE modules SET likes_count = 0, comments_count = 0");
    await pool.query("UPDATE courses SET likes_count = 0, comments_count = 0");
  });

  afterAll(async () => {
    await pool?.end();
    for (const s of [schema, ...extraSchemas]) await admin?.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin?.end();
  });

  describe("migrations", () => {
    it("are idempotent", async () => {
      const c = await pool.connect();
      try {
        expect(await migrateEngagement(c)).toEqual([]);
      } finally {
        c.release();
      }
    });

    it("are safe when several instances start at once", async () => {
      const s = schemaName();
      extraSchemas.push(s);
      const p = await schemaPool(admin, s, 6);
      try {
        const results = await Promise.all(
          Array.from({ length: 4 }, async () => {
            const c = await p.connect();
            try {
              return await migrateEngagement(c);
            } finally {
              c.release();
            }
          }),
        );
        expect(results.flat()).toEqual([1]); // applied exactly once
        expect(Number((await p.query("SELECT count(*)::int AS n FROM engagement_migrations")).rows[0]!.n)).toBe(1);
      } finally {
        await p.end();
      }
    });
  });

  describe("schema constraints", () => {
    const hash = "a".repeat(64);
    it("a like has exactly one actor", async () => {
      await expect(
        pool.query(
          "INSERT INTO engagement_likes (entity_type, entity_id, user_id, visitor_hash) VALUES ('lesson','l1','u',$1)",
          [hash],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("INSERT INTO engagement_likes (entity_type, entity_id) VALUES ('lesson','l1')"),
      ).rejects.toMatchObject({
        code: "23514",
      });
    });

    it("a user, and a guest, can like an entity once", async () => {
      const ins = (u: string | null, h: string | null) =>
        pool.query(
          "INSERT INTO engagement_likes (entity_type, entity_id, user_id, visitor_hash) VALUES ('lesson','l1',$1,$2)",
          [u, h],
        );
      await ins("u", null);
      await expect(ins("u", null)).rejects.toMatchObject({ code: "23505" });
      await ins(null, hash);
      await expect(ins(null, hash)).rejects.toMatchObject({ code: "23505" });
    });

    it("replies are one level deep and stay on their parent's entity", async () => {
      const snap = JSON.stringify({ name: "A" });
      const add = (entityId: string, parent: string | null) =>
        pool.query(
          "INSERT INTO engagement_comments (entity_type, entity_id, user_id, author_snapshot, parent_id, body) VALUES ('lesson',$1,'u',$2,$3,'x') RETURNING id",
          [entityId, snap, parent],
        );
      const top = (await add("l1", null)).rows[0]!.id as string;
      const reply = (await add("l1", top)).rows[0]!.id as string;
      await expect(add("l1", reply)).rejects.toMatchObject({ code: "23514" });
      await expect(add("l2", top)).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("likes and the transactional rollup", () => {
    it("a signed-in like counts lesson, module and course; unliking takes it back", async () => {
      expect(await service().toggleLike(lesson, { userId: "u1" })).toEqual({ liked: true, count: 1 });
      expect(await counts()).toMatchObject({ l1: { l: 1 }, m1: { l: 1 }, c1: { l: 1 } });
      expect(await service().toggleLike(lesson, { userId: "u1" })).toEqual({ liked: false, count: 0 });
      expect(await counts()).toMatchObject({ l1: { l: 0 }, m1: { l: 0 }, c1: { l: 0 } });
    });

    it("a guest is told apart by the visitor hash: the same one cannot like twice, two can", async () => {
      const a = { visitorHash: "a".repeat(64) };
      const b = { visitorHash: "b".repeat(64) };
      expect((await service().toggleLike(lesson, a)).liked).toBe(true);
      expect(await service().toggleLike(lesson, b)).toEqual({ liked: true, count: 2 });
      expect(await service().toggleLike(lesson, a)).toEqual({ liked: false, count: 1 });
      expect(await counts()).toMatchObject({ l1: { l: 1 }, c1: { l: 1 } });
    });

    it("a user and a guest are different likers", async () => {
      await service().toggleLike(lesson, { userId: "u1" });
      await service().toggleLike(lesson, { visitorHash: "a".repeat(64) });
      expect((await counts()).c1.l).toBe(2);
    });

    it("never double counts under concurrency: 20 simultaneous toggles by one user leave rollups equal to the rows", async () => {
      await Promise.all(Array.from({ length: 20 }, () => service().toggleLike(lesson, { userId: "u1" })));
      const n = await rows("engagement_likes", "entity_id = 'l1'");
      expect(n).toBeLessThanOrEqual(1);
      expect(await counts()).toMatchObject({ l1: { l: n }, m1: { l: n }, c1: { l: n } });
    });

    it("counts every one of 12 simultaneous guests exactly once", async () => {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          service().toggleLike(lesson, { visitorHash: i.toString(16).padStart(64, "0") }),
        ),
      );
      expect(await rows("engagement_likes")).toBe(12);
      expect(await counts()).toMatchObject({ l1: { l: 12 }, m1: { l: 12 }, c1: { l: 12 } });
    });

    it("rolls the like back when the hook fails", async () => {
      const failing = createEngagementService({
        pool,
        onCountChange: async () => {
          throw new Error("rollup failed");
        },
      });
      await expect(failing.toggleLike(lesson, { userId: "u1" })).rejects.toThrow("rollup failed");
      expect(await rows("engagement_likes")).toBe(0);
    });

    it("rolls back when the entity is unknown to the hook", async () => {
      await expect(service().toggleLike({ entityType: "lesson", entityId: "nope" }, { userId: "u1" })).rejects.toThrow(
        /unknown lesson/,
      );
      expect(await rows("engagement_likes")).toBe(0);
    });

    it("reports like state for a signed-in user and for a guest", async () => {
      await service().toggleLike(lesson, { userId: "u1" });
      expect(await service().likeState(lesson, { userId: "u1" })).toEqual({ liked: true, count: 1 });
      expect(await service().likeState(lesson, { userId: "u2" })).toEqual({ liked: false, count: 1 });
      expect(await service().likeState(lesson, { visitorHash: "c".repeat(64) })).toEqual({ liked: false, count: 1 });
      expect(await service().likeState(lesson)).toEqual({ liked: false, count: 1 });
    });

    it("rejects a malformed entity or visitor hash", async () => {
      await expect(
        service().toggleLike({ entityType: "Lesson!", entityId: "l1" }, { userId: "u" }),
      ).rejects.toBeInstanceOf(EngagementError);
      await expect(service().toggleLike(lesson, { visitorHash: "nothex" })).rejects.toBeInstanceOf(EngagementError);
    });
  });

  describe("comments and the rollup", () => {
    it("a comment and a reply each count once, up to the course", async () => {
      const top = await service().createComment({ entity: lesson, user: alice, body: "  First!  " });
      expect(top).toMatchObject({ body: "First!", parentId: null, author: { name: "Alice", role: "instructor" } });
      await service().createComment({ entity: lesson, user: bob, body: "Reply", parentId: top.id });
      expect(await counts()).toMatchObject({ l1: { c: 2 }, m1: { c: 2 }, c1: { c: 2 } });
    });

    it("refuses a reply to a reply, to a missing comment, and to a comment of another entity", async () => {
      const top = await service().createComment({ entity: lesson, user: alice, body: "top" });
      const reply = await service().createComment({ entity: lesson, user: bob, body: "r", parentId: top.id });
      for (const parentId of [reply.id, randomUUID(), "not-a-uuid"]) {
        await expect(service().createComment({ entity: lesson, user: bob, body: "x", parentId })).rejects.toMatchObject(
          {
            code: "invalid_parent",
          },
        );
      }
      await expect(
        service().createComment({ entity: lesson2, user: bob, body: "x", parentId: top.id }),
      ).rejects.toMatchObject({
        code: "invalid_parent",
      });
      expect((await counts()).c1.c).toBe(2);
    });

    it("limits the body to 2000 characters (code points) and refuses empty or NUL", async () => {
      await service().createComment({ entity: lesson, user: alice, body: "😀".repeat(2000) });
      for (const body of ["😀".repeat(2001), "   ", "a\u0000b", 42 as unknown as string]) {
        await expect(service().createComment({ entity: lesson, user: alice, body })).rejects.toMatchObject({
          code: "invalid_body",
        });
      }
    });

    it("rolls the comment back when the hook fails", async () => {
      const failing = createEngagementService({
        pool,
        onCountChange: async () => {
          throw new Error("rollup failed");
        },
      });
      await expect(failing.createComment({ entity: lesson, user: alice, body: "x" })).rejects.toThrow("rollup failed");
      expect(await rows("engagement_comments")).toBe(0);
    });

    it("deleting a comment removes its replies and takes exactly their count off the rollups", async () => {
      const top = await service().createComment({ entity: lesson, user: alice, body: "top" });
      await service().createComment({ entity: lesson, user: bob, body: "r1", parentId: top.id });
      await service().createComment({ entity: lesson, user: bob, body: "r2", parentId: top.id });
      const other = await service().createComment({ entity: lesson, user: bob, body: "other" });
      expect((await counts()).c1.c).toBe(4);
      expect(await service().deleteComment({ id: top.id, userId: alice.id })).toEqual({ removed: 3 });
      expect(await counts()).toMatchObject({ l1: { c: 1 }, m1: { c: 1 }, c1: { c: 1 } });
      expect(await rows("engagement_comments")).toBe(1);
      expect(await service().deleteComment({ id: other.id, userId: bob.id })).toEqual({ removed: 1 });
      expect((await counts()).c1.c).toBe(0);
    });

    it("deleting a reply takes off one", async () => {
      const top = await service().createComment({ entity: lesson, user: alice, body: "top" });
      const reply = await service().createComment({ entity: lesson, user: bob, body: "r", parentId: top.id });
      expect(await service().deleteComment({ id: reply.id, userId: bob.id })).toEqual({ removed: 1 });
      expect((await counts()).c1.c).toBe(1);
    });

    it("only the author or a moderator may delete; others get 403, a missing comment 404", async () => {
      const c = await service().createComment({ entity: lesson, user: alice, body: "mine" });
      await expect(service().deleteComment({ id: c.id, userId: bob.id })).rejects.toMatchObject({
        code: "forbidden",
        status: 403,
      });
      await expect(service().deleteComment({ id: randomUUID(), userId: bob.id })).rejects.toMatchObject({
        code: "not_found",
        status: 404,
      });
      await expect(service().deleteComment({ id: "nope", userId: bob.id })).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await service().deleteComment({ id: c.id, userId: bob.id, canModerate: true })).toEqual({ removed: 1 });
      expect((await counts()).c1.c).toBe(0);
    });

    it("a concurrent reply and delete of the parent never leave the rollup off", async () => {
      for (let i = 0; i < 10; i++) {
        const top = await service().createComment({ entity: lesson, user: alice, body: "top" });
        await Promise.allSettled([
          service().createComment({ entity: lesson, user: bob, body: "r", parentId: top.id }),
          service().deleteComment({ id: top.id, userId: alice.id }),
        ]);
        const n = await rows("engagement_comments", "status = 'visible'");
        expect((await counts()).l1.c).toBe(n);
      }
    });

    it("only the author edits, and the edit is stored trimmed", async () => {
      const c = await service().createComment({ entity: lesson, user: alice, body: "old" });
      const edited = await service().editComment({ id: c.id, userId: alice.id, body: " new " });
      expect(edited.body).toBe("new");
      expect(Date.parse(edited.updatedAt)).toBeGreaterThanOrEqual(Date.parse(c.updatedAt));
      await expect(service().editComment({ id: c.id, userId: bob.id, body: "hijack" })).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(service().editComment({ id: randomUUID(), userId: bob.id, body: "x" })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(service().editComment({ id: c.id, userId: alice.id, body: "" })).rejects.toMatchObject({
        code: "invalid_body",
      });
      expect((await counts()).c1.c).toBe(1); // editing never changes a count
    });

    it("lists pinned first, then oldest first, with replies nested; hidden comments stay out", async () => {
      const a = await service().createComment({ entity: lesson, user: alice, body: "a" });
      const b = await service().createComment({ entity: lesson, user: bob, body: "b" });
      const c = await service().createComment({ entity: lesson, user: bob, body: "c" });
      await service().createComment({ entity: lesson, user: alice, body: "reply to a", parentId: a.id });
      const hidden = await service().createComment({
        entity: lesson,
        user: alice,
        body: "hidden reply",
        parentId: a.id,
      });
      await service().createComment({ entity: lesson2, user: alice, body: "elsewhere" });
      await pool.query("UPDATE engagement_comments SET is_pinned = true WHERE id = $1", [c.id]);
      await pool.query("UPDATE engagement_comments SET status = 'hidden' WHERE id = $1", [hidden.id]);
      const { comments, total } = await service().listComments(lesson);
      expect(comments.map((x) => x.body)).toEqual(["c", "a", "b"]);
      expect(comments[1]!.replies.map((r) => r.body)).toEqual(["reply to a"]);
      expect(total).toBe(3);
      expect(b.id).toBeTruthy();
      const page = await service().listComments(lesson, { limit: 1, offset: 1 });
      expect(page.comments.map((x) => x.body)).toEqual(["a"]);
      expect(page.total).toBe(3);
    });

    it("refreshes the cached author of every comment of a user", async () => {
      await service().createComment({ entity: lesson, user: alice, body: "x" });
      await service().createComment({ entity: lesson2, user: alice, body: "y" });
      expect(await service().updateAuthorSnapshot(alice.id, { name: "Alice B.", avatarUrl: null, role: "admin" })).toBe(
        2,
      );
      expect(await service().updateAuthorSnapshot(alice.id, { name: "Alice B.", avatarUrl: null, role: "admin" })).toBe(
        0,
      );
      const { comments } = await service().listComments(lesson);
      expect(comments[0]!.author).toEqual({ name: "Alice B.", avatarUrl: null, role: "admin" });
    });

    it("keeps only an http(s) avatar URL in the snapshot", async () => {
      const c = await service().createComment({
        entity: lesson,
        user: { id: "u9", name: "Eve", avatarUrl: "javascript:alert(1)" },
        body: "x",
      });
      expect(c.author.avatarUrl).toBeNull();
    });
  });

  describe("HTTP handlers", () => {
    const sessions = new Map<string, SessionUser>([
      ["alice", { ...alice, canModerate: false }],
      ["bob", bob],
      ["admin", { id: "user-admin", name: "Admin", role: "admin", canModerate: true }],
    ]);
    const build = (limit = 15) =>
      createEngagementHandlers({
        service: service(),
        salt: SALT,
        limiter: createMemoryRateLimiter({ limit, windowMs: 60_000 }),
        entities: { lesson: { exists: async (id) => ["l1", "l2"].includes(id) } },
        resolveUser: (req) => sessions.get(req.headers.get("x-test-user") ?? "") ?? null,
        canComment: (user) => user.id !== "user-banned",
      });
    const call = (
      h: ReturnType<typeof build>,
      method: string,
      path: string,
      opts: { body?: unknown; user?: string; ip?: string; ua?: string; raw?: string } = {},
    ) =>
      h.handle(
        new Request(`http://app.test${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": opts.ip ?? "203.0.113.7",
            "user-agent": opts.ua ?? "test-agent",
            ...(opts.user ? { "x-test-user": opts.user } : {}),
          },
          ...(opts.raw !== undefined
            ? { body: opts.raw }
            : opts.body !== undefined
              ? { body: JSON.stringify(opts.body) }
              : {}),
        }),
      );
    const toggle = (h: ReturnType<typeof build>, o: Parameters<typeof call>[3] = {}) =>
      call(h, "POST", "/api/engagement/likes/toggle", { body: lesson, ...o });

    it("lets a guest like once and unlike, with one count each, never twice", async () => {
      const h = build();
      expect(await (await toggle(h)).json()).toEqual({ liked: true, count: 1 });
      expect(await (await toggle(h)).json()).toEqual({ liked: false, count: 0 });
      expect(await (await toggle(h)).json()).toEqual({ liked: true, count: 1 });
      expect((await counts()).c1.l).toBe(1);
    });

    it("a guest on another address, or with another User-Agent, is another visitor", async () => {
      const h = build();
      await toggle(h);
      await toggle(h, { ip: "198.51.100.9" });
      await toggle(h, { ua: "other-agent" });
      expect((await counts()).c1.l).toBe(3);
    });

    it("a forged left-hand X-Forwarded-For entry neither makes a new visitor nor escapes the rate limit", async () => {
      const h = build(3);
      for (let i = 0; i < 3; i++) expect((await toggle(h, { ip: `10.0.0.${i}, 203.0.113.7` })).status).toBe(200);
      const limited = await toggle(h, { ip: "10.0.0.99, 203.0.113.7" });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      // three toggles by ONE visitor: liked, unliked, liked
      expect((await counts()).c1.l).toBe(1);
    });

    it("limits to 15 toggles a minute per address", async () => {
      const h = build();
      const statuses: number[] = [];
      for (let i = 0; i < 17; i++) statuses.push((await toggle(h)).status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(15);
      expect(statuses.slice(15)).toEqual([429, 429]);
      expect((await toggle(h, { ip: "198.51.100.1" })).status).toBe(200);
    });

    it("counts a signed-in like under the user, not under the visitor", async () => {
      const h = build();
      await toggle(h, { user: "alice" });
      await toggle(h, { user: "alice", ip: "198.51.100.2" });
      expect(await rows("engagement_likes", "user_id = 'user-alice'")).toBe(0); // the second call unliked
      await toggle(h, { user: "alice" });
      expect(await rows("engagement_likes", "user_id = 'user-alice' AND visitor_hash IS NULL")).toBe(1);
    });

    it("GET /likes tells a guest and a signed-in person whether they liked, with the count", async () => {
      const h = build();
      const state = (o: Parameters<typeof call>[3] = {}) =>
        call(h, "GET", "/api/engagement/likes?entityType=lesson&entityId=l1", o).then((r) => r.json());
      expect(await state()).toEqual({ liked: false, count: 0 });
      await toggle(h);
      await toggle(h, { user: "alice" });
      expect(await state()).toEqual({ liked: true, count: 2 });
      expect(await state({ user: "alice" })).toEqual({ liked: true, count: 2 });
      expect(await state({ user: "bob" })).toEqual({ liked: false, count: 2 });
      expect(await state({ ip: "198.51.100.9" })).toEqual({ liked: false, count: 2 });
      expect((await call(h, "GET", "/api/engagement/likes?entityType=lesson&entityId=ghost")).status).toBe(404);
      expect((await call(h, "POST", "/api/engagement/likes", { body: lesson })).status).toBe(405);
    });

    it("caches the role authorRole gives for the entity, not the session's own", async () => {
      const h = createEngagementHandlers({
        service: service(),
        salt: SALT,
        limiter: createMemoryRateLimiter({ limit: 15, windowMs: 60_000 }),
        entities: { lesson: {} },
        resolveUser: () => ({ ...alice, role: "admin" }),
        authorRole: (user, entity) => (entity.entityId === "l1" ? "instructor" : null),
      });
      const post = async (entityId: string) =>
        (
          (await (
            await call(h, "POST", "/api/engagement/comments", { body: { entityType: "lesson", entityId, body: "hi" } })
          ).json()) as { comment: { author: { role: string | null } } }
        ).comment.author.role;
      expect(await post("l1")).toBe("instructor");
      expect(await post("l2")).toBeNull();
    });

    it("refuses unknown entity types, unknown entities and bad bodies", async () => {
      const h = build();
      expect(
        (await call(h, "POST", "/api/engagement/likes/toggle", { body: { entityType: "secret", entityId: "x" } }))
          .status,
      ).toBe(400);
      expect(
        (await call(h, "POST", "/api/engagement/likes/toggle", { body: { entityType: "lesson", entityId: "ghost" } }))
          .status,
      ).toBe(404);
      expect(
        (await call(h, "POST", "/api/engagement/likes/toggle", { body: { entityType: "constructor", entityId: "x" } }))
          .status,
      ).toBe(400);
      expect((await call(h, "POST", "/api/engagement/likes/toggle", { raw: "{nope" })).status).toBe(400);
      expect((await call(h, "POST", "/api/engagement/likes/toggle", { raw: "[1]" })).status).toBe(400);
      expect(
        (await call(h, "POST", "/api/engagement/comments", { user: "alice", raw: "x".repeat(20_000) })).status,
      ).toBe(413);
      expect(await rows("engagement_likes")).toBe(0);
    });

    it("guests can read comments but not write them; a signed-in person can; the permission check applies", async () => {
      const h = build();
      const body = { ...lesson, body: "hello" };
      expect((await call(h, "POST", "/api/engagement/comments", { body })).status).toBe(401);
      const created = await call(h, "POST", "/api/engagement/comments", { body, user: "alice" });
      expect(created.status).toBe(201);
      const { comment } = (await created.json()) as { comment: { id: string; author: { name: string } } };
      expect(comment.author.name).toBe("Alice");
      const list = await call(h, "GET", "/api/engagement/comments?entityType=lesson&entityId=l1");
      expect(list.status).toBe(200);
      expect(((await list.json()) as { comments: unknown[] }).comments).toHaveLength(1);
      sessions.set("banned", { id: "user-banned", name: "Banned" });
      expect((await call(h, "POST", "/api/engagement/comments", { body, user: "banned" })).status).toBe(403);
    });

    it("edits and deletes: the author, a moderator, and nobody else", async () => {
      const h = build();
      const created = await call(h, "POST", "/api/engagement/comments", {
        body: { ...lesson, body: "mine" },
        user: "alice",
      });
      const id = ((await created.json()) as { comment: { id: string } }).comment.id;
      const path = `/api/engagement/comments/${id}`;
      expect((await call(h, "PATCH", path, { body: { body: "x" } })).status).toBe(401);
      expect((await call(h, "PATCH", path, { body: { body: "x" }, user: "bob" })).status).toBe(403);
      expect((await call(h, "PATCH", path, { body: { body: "edited" }, user: "alice" })).status).toBe(200);
      expect((await call(h, "DELETE", path, { user: "bob" })).status).toBe(403);
      expect((await call(h, "DELETE", path)).status).toBe(401);
      expect((await call(h, "DELETE", path, { user: "admin" })).status).toBe(200);
      expect((await call(h, "DELETE", path, { user: "admin" })).status).toBe(404);
      expect((await counts()).c1.c).toBe(0);
    });

    it("answers 404 for unknown routes and 405 for the wrong method", async () => {
      const h = build();
      expect((await call(h, "GET", "/api/engagement/nope")).status).toBe(404);
      expect((await call(h, "GET", "/elsewhere")).status).toBe(404);
      expect((await call(h, "GET", "/api/engagement/comments/not-a-uuid")).status).toBe(404);
      const r = await call(h, "GET", "/api/engagement/likes/toggle");
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    });

    it("will not start without a salt", () => {
      expect(() =>
        createEngagementHandlers({
          service: service(),
          salt: "",
          limiter: createMemoryRateLimiter({ limit: 1, windowMs: 1000 }),
          entities: {},
          resolveUser: () => null,
        }),
      ).toThrow(/ENGAGEMENT_SALT/);
    });
  });
});

describe.skipIf(!REDIS_URL)("Redis sliding-window limiter (real Redis)", () => {
  let redis: Redis;
  const prefix = `engagement-test:${randomUUID()}:`;
  beforeAll(() => {
    redis = new Redis(REDIS_URL!);
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it("allows `limit` hits, then refuses with a retry time, per key", async () => {
    const rl = createRedisRateLimiter({ redis, limit: 3, windowMs: 5000, prefix, failOpen: false });
    expect(await rl.hit("a")).toEqual({ ok: true, remaining: 2 });
    expect(await rl.hit("a")).toEqual({ ok: true, remaining: 1 });
    expect(await rl.hit("a")).toEqual({ ok: true, remaining: 0 });
    const refused = await rl.hit("a");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((await rl.hit("b")).ok).toBe(true);
  });

  it("slides: allowed again once the window has passed", async () => {
    const rl = createRedisRateLimiter({ redis, limit: 1, windowMs: 300, prefix, failOpen: false });
    expect((await rl.hit("slide")).ok).toBe(true);
    expect((await rl.hit("slide")).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect((await rl.hit("slide")).ok).toBe(true);
  });

  it("is atomic: 40 simultaneous hits against a limit of 15 let exactly 15 through", async () => {
    const rl = createRedisRateLimiter({ redis, limit: 15, windowMs: 10_000, prefix, failOpen: false });
    const results = await Promise.all(Array.from({ length: 40 }, () => rl.hit("burst")));
    expect(results.filter((r) => r.ok)).toHaveLength(15);
  });

  it("expires its key, so idle clients cost no memory", async () => {
    const rl = createRedisRateLimiter({ redis, limit: 1, windowMs: 200, prefix, failOpen: false });
    await rl.hit("ttl");
    expect(await redis.exists(`${prefix}ttl`)).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await redis.exists(`${prefix}ttl`)).toBe(0);
  });
});
