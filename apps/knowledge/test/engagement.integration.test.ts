/**
 * Likes and comments on lessons (@asafarim/engagement) with Knowledge's rollups, on a real PostgreSQL: every like and
 * comment counts on the lesson, its module and its course in the same transaction; publishing another revision
 * recounts the course and its modules from the lessons it now has; only lessons of a published course can be
 * engaged with. Runs when KNOWLEDGE_TEST_DATABASE_URL names a server where it may create a throwaway database.
 */
import { randomBytes } from "node:crypto";
import {
  createEngagementHandlers,
  createEngagementService,
  createMemoryRateLimiter,
  migrateEngagement,
  type EngagementService,
} from "@asafarim/engagement";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { createArticle, publishRevision } from "../lib/content";
import {
  createCourse,
  editCourse,
  getPublishedCourse,
  getStudioCourse,
  publishCourse,
  withdrawCourse,
  type CourseEdit,
} from "../lib/courses";
import {
  resolveLessonArticle,
  applyCountChange,
  countsOf,
  courseCounts,
  isPublicArticle,
  articleCounts,
} from "../lib/engagement-rollups";
import { reconcileEngagement } from "../lib/engagement-reconcile";
import { COMMENT_CREATED, publishCommentCreated } from "../lib/events";
import { migrate, MIGRATIONS } from "../lib/migrations";
import type { Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe.skipIf(!ADMIN_URL)("engagement on lessons, with rollups (PostgreSQL)", () => {
  const dbName = `knowledge_engagement_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let service: EngagementService;
  let courseId: string;
  let lessons: { a: string; b: string; c: string };

  async function edit(id: string, edits: CourseEdit[]) {
    let rev = (await getStudioCourse(pool, alice, id))!.draftRevisionId;
    for (const e of edits) rev = ok(await editCourse(pool, alice, { id, expectedRevisionId: rev, edit: e })).revisionId;
    return rev;
  }
  const publication = async (id: string) => (await getStudioCourse(pool, alice, id))!.publication;
  const counts = async () => courseCounts(pool, (await getPublishedCourse(pool, "engaging"))!);
  const articleIds = new Map<string, string>();
  const lesson = (lessonId: string) => ({ entityType: "article", entityId: articleIds.get(lessonId)! });
  const user = (id: string) => ({ id, name: id });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    pool.on("error", () => undefined);
    const c = await pool.connect();
    try {
      await migrate(c);
      await migrateEngagement(c);
    } finally {
      c.release();
    }
    service = createEngagementService({
      pool,
      onCountChange: (type, id, metric, delta, tx) => applyCountChange(tx, type, id, metric, delta),
      onCommentCreated: (comment, tx) => publishCommentCreated(tx, comment),
    });
    for (const slug of ["one", "two", "three"]) {
      const a = ok(await createArticle(pool, alice, { slug, draft: { title: slug, summary: "", body: slug } }));
      ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    }
    const course = ok(await createCourse(pool, alice, { slug: "engaging", title: "Engaging" }));
    courseId = course.id;
    const rev = await edit(courseId, [
      { op: "add_module", title: "M0" },
      { op: "add_lesson", module: 0, articleSlug: "one" },
      { op: "add_lesson", module: 0, articleSlug: "two" },
      { op: "add_module", title: "M1" },
      { op: "add_lesson", module: 1, articleSlug: "three" },
    ]);
    ok(await publishCourse(pool, alice, { id: courseId, revisionId: rev, publication: await publication(courseId) }));
    const [a, b, c3] = (await getPublishedCourse(pool, "engaging"))!.modules.flatMap((m) => m.lessons);
    for (const l of [a!, b!, c3!]) articleIds.set(l.lessonId, l.itemId);
    lessons = { a: a!.lessonId, b: b!.lessonId, c: c3!.lessonId };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("merges legacy user and guest likes and preserves reply IDs across two lesson placements", async () => {
    const second = ok(await createCourse(pool, alice, { slug: "another-course", title: "Another course" }));
    const rev = await edit(second.id, [
      { op: "add_module", title: "First" },
      { op: "add_lesson", module: 0, articleSlug: "one" },
    ]);
    ok(await publishCourse(pool, alice, { id: second.id, revisionId: rev, publication: 0 }));
    const outlines = [
      (await getPublishedCourse(pool, "engaging"))!,
      (await getPublishedCourse(pool, "another-course"))!,
    ];
    const other = outlines[1]!.modules[0]!.lessons[0]!;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // Recreate the v13 counter schema in this transaction and exercise the shipped upgrade SQL.
      await c.query("ALTER TABLE courses ADD likes_count integer, ADD comments_count integer");
      const ids = [other.lessonId, lessons.a];
      await c.query(
        `INSERT INTO engagement_likes(entity_type,entity_id,user_id)
         SELECT 'lesson',id,'same-person' FROM unnest($1::text[]) id`,
        [ids],
      );
      await c.query(
        `INSERT INTO engagement_likes(entity_type,entity_id,visitor_hash)
         SELECT 'lesson',id,repeat('a',64) FROM unnest($1::text[]) id`,
        [ids],
      );
      const insert = `INSERT INTO engagement_comments(entity_type,entity_id,user_id,author_snapshot,body,parent_id)
                      VALUES ('lesson',$1,'reader','{}','hello',$2) RETURNING id`;
      const parent = (await c.query(insert, [other.lessonId, null])).rows[0].id;
      const reply = (await c.query(insert, [other.lessonId, parent])).rows[0].id;
      await c.query(MIGRATIONS.find((m) => m.version === 14)!.sql);
      expect(
        (await c.query("SELECT entity_type,entity_id,parent_id FROM engagement_comments WHERE id=$1", [reply])).rows[0],
      ).toEqual({ entity_type: "article", entity_id: other.itemId, parent_id: parent });
      expect(countsOf(await articleCounts(c, [other.itemId]), other.itemId)).toEqual({ likes: 2, comments: 2 });
      expect(await resolveLessonArticle(c, lessons.a)).toEqual(await resolveLessonArticle(c, other.lessonId));
      for (const outline of outlines) {
        expect((await courseCounts(c, outline)).course).toEqual({
          likes: 2,
          comments: 2,
        });
      }
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("counts likes and comments on the lesson, its module and its course; undoing takes them back", async () => {
    await service.toggleLike(lesson(lessons.a), { userId: "u1" });
    await service.toggleLike(lesson(lessons.a), { userId: "u2" });
    await service.toggleLike(lesson(lessons.c), { userId: "u1" });
    const top = await service.createComment({ entity: lesson(lessons.b), user: user("u1"), body: "Nice" });
    await service.createComment({ entity: lesson(lessons.b), user: user("u2"), body: "Agreed", parentId: top.id });
    let n = await counts();
    expect(countsOf(n.lessons, lessons.a)).toEqual({ likes: 2, comments: 0 });
    expect(countsOf(n.lessons, lessons.b)).toEqual({ likes: 0, comments: 2 });
    expect(countsOf(await articleCounts(pool, [lesson(lessons.a).entityId]), lesson(lessons.a).entityId)).toEqual(
      countsOf(n.lessons, lessons.a),
    );
    expect(countsOf(n.modules, 0)).toEqual({ likes: 2, comments: 2 });
    expect(countsOf(n.modules, 1)).toEqual({ likes: 1, comments: 0 });
    expect(n.course).toEqual({ likes: 3, comments: 2 });

    await service.toggleLike(lesson(lessons.a), { userId: "u2" }); // unlike
    await service.deleteComment({ id: top.id, userId: "u1" }); // takes its reply with it
    n = await counts();
    expect(countsOf(n.modules, 0)).toEqual({ likes: 1, comments: 0 });
    expect(n.course).toEqual({ likes: 2, comments: 0 });
  });

  it("never double counts concurrent likes on lessons of one course", async () => {
    const before = (await counts()).course.likes;
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        service.toggleLike(lesson(i % 2 ? lessons.b : lessons.c), { userId: `crowd-${i}` }),
      ),
    );
    const n = await counts();
    expect(n.course.likes).toBe(before + 16);
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM engagement_likes");
    expect(n.course.likes).toBe(rows[0]!.n);
    expect(countsOf(n.modules, 0).likes + countsOf(n.modules, 1).likes).toBe(n.course.likes);
  });

  it("publishing a revision with moved and removed lessons recounts the modules and the course", async () => {
    const before = await counts();
    const cLikes = countsOf(before.lessons, lessons.c).likes;
    const bLikes = countsOf(before.lessons, lessons.b).likes;
    // c moves up into M0, then b leaves the course.
    const rev = await edit(courseId, [
      { op: "move_lesson", lessonId: lessons.c, delta: -1 },
      { op: "remove_lesson", lessonId: lessons.b },
    ]);
    ok(await publishCourse(pool, alice, { id: courseId, revisionId: rev, publication: await publication(courseId) }));
    const n = await counts();
    const aLikes = countsOf(n.lessons, lessons.a).likes;
    expect(countsOf(n.modules, 0).likes).toBe(aLikes + cLikes);
    expect(countsOf(n.modules, 1)).toEqual({ likes: 0, comments: 0 }); // M1 is empty now
    expect(n.course.likes).toBe(aLikes + cLikes);
    expect(bLikes).toBeGreaterThan(0);
    expect(await isPublicArticle(pool, lesson(lessons.b).entityId)).toBe(true); // still published as an article
  });

  it("withdrawing a course leaves its public article engageable and republishing uses current counts", async () => {
    ok(await withdrawCourse(pool, alice, { id: courseId, publication: await publication(courseId) }));
    expect(await isPublicArticle(pool, lesson(lessons.a).entityId)).toBe(true);
    // Taking back an earlier like while withdrawn (a delete still reaches the service): only the lesson changes.
    await service.toggleLike(lesson(lessons.a), { userId: "u1" });
    const draft = (await getStudioCourse(pool, alice, courseId))!.draftRevisionId;
    ok(await publishCourse(pool, alice, { id: courseId, revisionId: draft, publication: await publication(courseId) }));
    const n = await counts();
    const sum = countsOf(n.lessons, lessons.a).likes + countsOf(n.lessons, lessons.c).likes;
    expect(n.course.likes).toBe(sum);
    expect(countsOf(n.modules, 0).likes).toBe(sum);
  });

  it("a new comment leaves knowledge.comment.created.v2 in the outbox, with identifiers and never the text", async () => {
    const before = Number((await pool.query("SELECT count(*)::int AS n FROM asafarim_outbox")).rows[0].n);
    const c = await service.createComment({ entity: lesson(lessons.a), user: user("writer"), body: "secret words" });
    const { rows } = await pool.query<{ type: string; envelope: { subject: string; data: Record<string, unknown> } }>(
      "SELECT type, envelope FROM asafarim_outbox ORDER BY seq DESC LIMIT 1",
    );
    expect(Number((await pool.query("SELECT count(*)::int AS n FROM asafarim_outbox")).rows[0].n)).toBe(before + 1);
    expect(rows[0]!.type).toBe(COMMENT_CREATED);
    expect(rows[0]!.envelope.subject).toBe(c.id);
    expect(rows[0]!.envelope.data).toEqual({
      commentId: c.id,
      articleId: lesson(lessons.a).entityId,
      parentId: null,
      author: "writer",
      createdAt: c.createdAt,
    });
    expect(JSON.stringify(rows[0]!.envelope)).not.toContain("secret words");
    await service.deleteComment({ id: c.id, userId: "writer" });
  });

  it("the nightly recount heals counts that drifted from the rows, and changes nothing when they agree", async () => {
    expect((await reconcileEngagement(pool)).articles).toBe(0);
    const truth = await counts();
    await pool.query(
      "UPDATE engagement_rollups SET likes_count = likes_count + 7, comments_count = 3 WHERE entity_type = 'article'",
    );
    const result = await reconcileEngagement(pool);
    expect(result.articles).toBeGreaterThan(0);
    expect(await counts()).toEqual(truth);
    expect((await reconcileEngagement(pool)).articles).toBe(0);
  });

  it("the handlers refuse missing articles and route lesson aliases to the article discussion", async () => {
    const h = createEngagementHandlers({
      service,
      salt: "knowledge-test-salt-0123456789",
      limiter: createMemoryRateLimiter({ limit: 15, windowMs: 60_000 }),
      entities: {
        lesson: { resolve: (id) => resolveLessonArticle(pool, id) },
        article: { exists: (id) => isPublicArticle(pool, id) },
      },
      resolveUser: () => user("reader"),
    });
    const toggle = (entityId: string, entityType = "article") =>
      h.handle(
        new Request("http://learn.test/api/engagement/likes/toggle", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", "user-agent": "t" },
          body: JSON.stringify({ entityType, entityId }),
        }),
      );
    expect((await toggle("missing")).status).toBe(404);
    expect((await toggle(lessons.b, "lesson")).status).toBe(404);
    const added = await toggle(lessons.a, "lesson");
    expect(await added.json()).toMatchObject({ liked: true });
    expect(await (await toggle(lesson(lessons.a).entityId)).json()).toMatchObject({ liked: false });

    const comments = "http://learn.test/api/engagement/comments";
    const post = async (entityType: string, entityId: string, body: string, parentId?: string) => {
      const response = await h.handle(
        new Request(comments, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entityType, entityId, body, parentId }),
        }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).comment.id;
    };
    const articleId = lesson(lessons.a).entityId;
    const parentId = await post("lesson", lessons.a, "Shared question");
    const replyId = await post("article", articleId, "Shared answer", parentId);
    for (const [type, id] of [
      ["lesson", lessons.a],
      ["article", articleId],
    ]) {
      const response = await h.handle(new Request(`${comments}?entityType=${type}&entityId=${id}`));
      expect((await response.json()).comments).toContainEqual(
        expect.objectContaining({
          id: parentId,
          replies: [expect.objectContaining({ id: replyId, parentId })],
        }),
      );
    }
  });
});
