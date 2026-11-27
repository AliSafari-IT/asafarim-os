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
  applyCountChange,
  countsOf,
  courseCounts,
  isEngageableLesson,
  lessonCourseOwner,
} from "../lib/engagement-rollups";
import { migrate } from "../lib/migrations";
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
  const lesson = (entityId: string) => ({ entityType: "lesson", entityId });
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
    lessons = { a: a!.lessonId, b: b!.lessonId, c: c3!.lessonId };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("only lessons of a published course with a public article can be engaged with", async () => {
    expect(await isEngageableLesson(pool, lessons.a)).toBe(true);
    expect(await isEngageableLesson(pool, "00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(await lessonCourseOwner(pool, lessons.a)).toBe("alice");
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
    expect(await isEngageableLesson(pool, lessons.b)).toBe(false); // not in the published revision any more
  });

  it("a withdrawn course stops engagement; its counts come back right when it is published again", async () => {
    ok(await withdrawCourse(pool, alice, { id: courseId, publication: await publication(courseId) }));
    expect(await isEngageableLesson(pool, lessons.a)).toBe(false);
    // Taking back an earlier like while withdrawn (a delete still reaches the service): only the lesson changes.
    await service.toggleLike(lesson(lessons.a), { userId: "u1" });
    const draft = (await getStudioCourse(pool, alice, courseId))!.draftRevisionId;
    ok(await publishCourse(pool, alice, { id: courseId, revisionId: draft, publication: await publication(courseId) }));
    const n = await counts();
    const sum = countsOf(n.lessons, lessons.a).likes + countsOf(n.lessons, lessons.c).likes;
    expect(n.course.likes).toBe(sum);
    expect(countsOf(n.modules, 0).likes).toBe(sum);
  });

  it("the handlers refuse a lesson that isn't engageable, and accept one that is", async () => {
    const h = createEngagementHandlers({
      service,
      salt: "knowledge-test-salt-0123456789",
      limiter: createMemoryRateLimiter({ limit: 15, windowMs: 60_000 }),
      entities: { lesson: { exists: (id) => isEngageableLesson(pool, id) } },
      resolveUser: () => null,
    });
    const toggle = (entityId: string) =>
      h.handle(
        new Request("http://learn.test/api/engagement/likes/toggle", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", "user-agent": "t" },
          body: JSON.stringify({ entityType: "lesson", entityId }),
        }),
      );
    expect((await toggle(lessons.b)).status).toBe(404);
    expect((await toggle(lessons.a)).status).toBe(200);
  });
});
