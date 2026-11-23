/**
 * Courses (#358): ordered lessons, grouped in modules, each pinned to one revision of a published article.
 *
 * A course is stored like an article: immutable revisions, a draft head and a published pointer. Every studio change
 * (title, a module, a lesson's place or pin) writes a new revision on top of the one the editor opened, so the
 * published course is exactly one revision and never moves when an article gets a new draft or is published again.
 * A lesson may only be pinned to its article's CURRENT published revision (when it is added, or "updated to latest");
 * a pin carried over from the previous revision stays as it was.
 *
 * Eligibility is read live: a lesson whose article is not public now (withdrawn) is hidden from guests and blocks
 * publishing the course. Like lib/content.ts, every mutation re-checks the policy against the locked row in the
 * transaction that writes; the public reads take no actor and only follow published pointers.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Doc } from "./doc";
import { canCreateCourse, canManageCourse, seesAllCourses, type Actor } from "./policy";
import { PAGE_SIZE, pageOf, type Page, type RevisionFormat } from "./content";
import { decodeCursor } from "./cursor";

type Pool = Pick<pg.Pool, "connect" | "query">;
type Client = Pick<pg.PoolClient, "query">;

export const COURSE_LIMITS = { title: 200, summary: 500, modules: 20, lessons: 100 } as const;

export interface LessonRef {
  /** Stable across the course's revisions: the lesson's URL. */
  lessonId: string;
  itemId: string;
  /** The pinned article revision. */
  itemRevisionId: string;
}

export interface CourseDraft {
  title: string;
  summary: string;
  modules: { title: string; lessons: LessonRef[] }[];
}

export type CourseStatus = "draft" | "published" | "withdrawn";

export type CourseError =
  | "forbidden"
  | "not_found"
  | "slug_taken"
  | "invalid_slug"
  | "invalid_title"
  | "conflict"
  | "not_published"
  | "too_many_modules"
  | "too_many_lessons"
  | "unknown_module"
  | "unknown_lesson"
  | "article_not_public"
  | "not_pinnable"
  | "duplicate_lesson"
  | "empty_course"
  | "lesson_unavailable";

export type CourseResult<T> = ({ ok: true } & T) | { ok: false; error: CourseError; detail?: string };

interface CourseRow {
  id: string;
  slug: string;
  owner_subject: string;
  draft_revision_id: string;
  published_revision_id: string | null;
  published_at: Date | null;
  withdrawn_at: Date | null;
  publication: number;
  updated_at: Date;
}

const statusOf = (r: Pick<CourseRow, "published_revision_id" | "withdrawn_at">): CourseStatus =>
  r.published_revision_id ? "published" : r.withdrawn_at ? "withdrawn" : "draft";

const ownerOf = (r: CourseRow) => ({ ownerSubject: r.owner_subject });

async function inTransaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function audit(c: Client, actor: Actor, action: string, courseId: string, revisionId: string | null) {
  await c.query("INSERT INTO course_audit_events (actor, action, course_id, revision_id) VALUES ($1, $2, $3, $4)", [
    `user:${actor.subject}`,
    action,
    courseId,
    revisionId,
  ]);
}

const lockCourse = async (c: Client, id: string) =>
  (await c.query<CourseRow>("SELECT * FROM courses WHERE id = $1 FOR UPDATE", [id])).rows[0];

const cleanTitle = (s: string) => s.replace(/\s+/g, " ").trim();

/** A course revision as stored: its modules in order, each with its lessons in order. */
async function readDraft(c: Pick<Pool, "query">, revisionId: string): Promise<CourseDraft> {
  const rev = (
    await c.query<{ title: string; summary: string }>("SELECT title, summary FROM course_revisions WHERE id = $1", [
      revisionId,
    ])
  ).rows[0]!;
  const modules = (
    await c.query<{ position: number; title: string }>(
      "SELECT position, title FROM course_modules WHERE revision_id = $1 ORDER BY position",
      [revisionId],
    )
  ).rows;
  const lessons = (
    await c.query<{ lesson_id: string; module_position: number; item_id: string; item_revision_id: string }>(
      `SELECT lesson_id, module_position, item_id, item_revision_id FROM course_lessons
       WHERE revision_id = $1 ORDER BY module_position, position`,
      [revisionId],
    )
  ).rows;
  return {
    title: rev.title,
    summary: rev.summary,
    modules: modules.map((m) => ({
      title: m.title,
      lessons: lessons
        .filter((l) => l.module_position === m.position)
        .map((l) => ({ lessonId: l.lesson_id, itemId: l.item_id, itemRevisionId: l.item_revision_id })),
    })),
  };
}

async function insertRevision(c: Client, courseId: string, draft: CourseDraft, author: string): Promise<string> {
  const { rows } = await c.query<{ n: number }>(
    "SELECT coalesce(max(number), 0)::int AS n FROM course_revisions WHERE course_id = $1",
    [courseId],
  );
  const id = randomUUID();
  await c.query(
    "INSERT INTO course_revisions (id, course_id, number, title, summary, author) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, courseId, rows[0]!.n + 1, draft.title, draft.summary, author],
  );
  if (draft.modules.length) {
    await c.query(
      `INSERT INTO course_modules (revision_id, position, title)
       SELECT $1, m.ord - 1, m.title FROM unnest($2::text[]) WITH ORDINALITY AS m (title, ord)`,
      [id, draft.modules.map((m) => m.title)],
    );
  }
  const lessons = draft.modules.flatMap((m, mi) => m.lessons.map((l, li) => ({ ...l, mi, li })));
  if (lessons.length) {
    await c.query(
      `INSERT INTO course_lessons (revision_id, lesson_id, module_position, position, item_id, item_revision_id)
       SELECT $1, l.lesson_id, l.mi, l.li, l.item_id, l.rev
       FROM unnest($2::text[], $3::int[], $4::int[], $5::text[], $6::text[]) AS l (lesson_id, mi, li, item_id, rev)`,
      [
        id,
        lessons.map((l) => l.lessonId),
        lessons.map((l) => l.mi),
        lessons.map((l) => l.li),
        lessons.map((l) => l.itemId),
        lessons.map((l) => l.itemRevisionId),
      ],
    );
  }
  return id;
}

/** Shape and limits of a draft; the pins are checked against the database separately. */
function checkDraft(draft: CourseDraft): CourseError | null {
  if (!draft.title || draft.title.length > COURSE_LIMITS.title || draft.summary.length > COURSE_LIMITS.summary)
    return "invalid_title";
  if (draft.modules.length > COURSE_LIMITS.modules) return "too_many_modules";
  if (draft.modules.some((m) => !m.title || m.title.length > COURSE_LIMITS.title)) return "invalid_title";
  const lessons = draft.modules.flatMap((m) => m.lessons);
  if (lessons.length > COURSE_LIMITS.lessons) return "too_many_lessons";
  if (new Set(lessons.map((l) => l.lessonId)).size !== lessons.length) return "duplicate_lesson";
  return null;
}

/** The article's current published revision, by id or slug, or null when it isn't public. */
async function publicRevisionOf(c: Client, by: { itemId?: string; slug?: string }) {
  const { rows } = await c.query<{ id: string; published_revision_id: string }>(
    `SELECT id, published_revision_id FROM content_items
     WHERE (id = $1 OR slug = $2) AND published_revision_id IS NOT NULL`,
    [by.itemId ?? null, by.slug ?? null],
  );
  return rows[0] ? { itemId: rows[0].id, revisionId: rows[0].published_revision_id } : null;
}

export async function createCourse(
  pool: Pool,
  actor: Actor,
  input: { slug: string; title: string; summary?: string },
): Promise<CourseResult<{ id: string; revisionId: string }>> {
  if (!canCreateCourse(actor)) return { ok: false, error: "forbidden" };
  const draft: CourseDraft = { title: cleanTitle(input.title), summary: (input.summary ?? "").trim(), modules: [] };
  const bad = checkDraft(draft);
  if (bad) return { ok: false, error: bad };
  return inTransaction(pool, async (c) => {
    const id = randomUUID();
    const inserted = await c.query(
      "INSERT INTO courses (id, owner_subject, slug) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING",
      [id, actor.subject, input.slug],
    );
    if (inserted.rowCount === 0) return { ok: false, error: "slug_taken" } as const;
    const revisionId = await insertRevision(c, id, draft, actor.subject);
    await c.query("UPDATE courses SET draft_revision_id = $2 WHERE id = $1", [id, revisionId]);
    await audit(c, actor, "course.created", id, revisionId);
    return { ok: true, id, revisionId } as const;
  });
}

/** One studio change, applied to the draft head the editor opened (else `conflict`), written as a new revision. */
export type CourseEdit =
  | { op: "meta"; title: string; summary: string }
  | { op: "add_module"; title: string }
  | { op: "rename_module"; module: number; title: string }
  | { op: "remove_module"; module: number }
  | { op: "add_lesson"; module: number; articleSlug: string }
  | { op: "move_lesson"; lessonId: string; delta: -1 | 1 }
  | { op: "remove_lesson"; lessonId: string }
  | { op: "update_lesson"; lessonId: string };

const findLesson = (d: CourseDraft, lessonId: string) => {
  for (const [mi, m] of d.modules.entries()) {
    const li = m.lessons.findIndex((l) => l.lessonId === lessonId);
    if (li >= 0) return { mi, li };
  }
  return null;
};

async function applyEdit(c: Client, d: CourseDraft, edit: CourseEdit): Promise<CourseDraft | CourseError> {
  const next: CourseDraft = { ...d, modules: d.modules.map((m) => ({ ...m, lessons: [...m.lessons] })) };
  switch (edit.op) {
    case "meta":
      return { ...next, title: cleanTitle(edit.title), summary: edit.summary.trim() };
    case "add_module":
      next.modules.push({ title: cleanTitle(edit.title), lessons: [] });
      return next;
    case "rename_module":
      if (!next.modules[edit.module]) return "unknown_module";
      next.modules[edit.module]!.title = cleanTitle(edit.title);
      return next;
    case "remove_module":
      if (!next.modules[edit.module]) return "unknown_module";
      next.modules.splice(edit.module, 1);
      return next;
    case "add_lesson": {
      const m = next.modules[edit.module];
      if (!m) return "unknown_module";
      const pin = await publicRevisionOf(c, { slug: edit.articleSlug });
      if (!pin) return "article_not_public";
      m.lessons.push({ lessonId: randomUUID(), itemId: pin.itemId, itemRevisionId: pin.revisionId });
      return next;
    }
    case "move_lesson": {
      const at = findLesson(next, edit.lessonId);
      if (!at) return "unknown_lesson";
      const lessons = next.modules[at.mi]!.lessons;
      const to = at.li + edit.delta;
      if (to >= 0 && to < lessons.length) {
        [lessons[at.li], lessons[to]] = [lessons[to]!, lessons[at.li]!];
      } else {
        // Past the end of its module: into the neighbouring module, at its near end.
        const other = next.modules[at.mi + edit.delta];
        if (!other) return next;
        const [moved] = lessons.splice(at.li, 1);
        if (edit.delta < 0) other.lessons.push(moved!);
        else other.lessons.unshift(moved!);
      }
      return next;
    }
    case "remove_lesson": {
      const at = findLesson(next, edit.lessonId);
      if (!at) return "unknown_lesson";
      next.modules[at.mi]!.lessons.splice(at.li, 1);
      return next;
    }
    case "update_lesson": {
      const at = findLesson(next, edit.lessonId);
      if (!at) return "unknown_lesson";
      const lesson = next.modules[at.mi]!.lessons[at.li]!;
      const pin = await publicRevisionOf(c, { itemId: lesson.itemId });
      if (!pin) return "article_not_public";
      next.modules[at.mi]!.lessons[at.li] = { ...lesson, itemRevisionId: pin.revisionId };
      return next;
    }
  }
}

/**
 * Every pin is either unchanged from the base revision or the article's current published revision: a lesson can't
 * point at a draft, or at an old revision that was never what the course showed.
 */
async function pinsAllowed(c: Client, base: CourseDraft, next: CourseDraft): Promise<boolean> {
  const before = new Set(base.modules.flatMap((m) => m.lessons.map((l) => `${l.lessonId}|${l.itemRevisionId}`)));
  const fresh = next.modules.flatMap((m) => m.lessons).filter((l) => !before.has(`${l.lessonId}|${l.itemRevisionId}`));
  if (!fresh.length) return true;
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM unnest($1::text[], $2::text[]) AS f (item_id, rev)
     JOIN content_items i ON i.id = f.item_id AND i.published_revision_id = f.rev`,
    [fresh.map((l) => l.itemId), fresh.map((l) => l.itemRevisionId)],
  );
  return rows[0]!.n === fresh.length;
}

export async function editCourse(
  pool: Pool,
  actor: Actor,
  input: { id: string; expectedRevisionId: string; edit: CourseEdit },
): Promise<CourseResult<{ revisionId: string }>> {
  return inTransaction(pool, async (c) => {
    const course = await lockCourse(c, input.id);
    if (!course || !canManageCourse(actor, ownerOf(course))) return { ok: false, error: "not_found" } as const;
    if (course.draft_revision_id !== input.expectedRevisionId) return { ok: false, error: "conflict" } as const;
    const base = await readDraft(c, course.draft_revision_id);
    const next = await applyEdit(c, base, input.edit);
    if (typeof next === "string") return { ok: false, error: next } as const;
    const bad = checkDraft(next);
    if (bad) return { ok: false, error: bad } as const;
    if (!(await pinsAllowed(c, base, next))) return { ok: false, error: "not_pinnable" } as const;
    const revisionId = await insertRevision(c, course.id, next, actor.subject);
    await c.query("UPDATE courses SET draft_revision_id = $2, updated_at = now() WHERE id = $1", [
      course.id,
      revisionId,
    ]);
    await audit(c, actor, "course.saved", course.id, revisionId);
    return { ok: true, revisionId } as const;
  });
}

/** Lessons of a revision whose article isn't public now, by the pinned revision's title. */
async function unavailableLessons(c: Pick<Pool, "query">, revisionId: string): Promise<string[]> {
  const { rows } = await c.query<{ title: string }>(
    `SELECT r.title FROM course_lessons l
     JOIN content_items i ON i.id = l.item_id
     JOIN content_revisions r ON r.id = l.item_revision_id
     WHERE l.revision_id = $1 AND i.published_revision_id IS NULL
     ORDER BY l.module_position, l.position`,
    [revisionId],
  );
  return rows.map((r) => r.title);
}

/**
 * Publish the course's draft head: only when it has a lesson and every lesson's article is public now. A withdrawn
 * article blocks the course, naming the lessons in `detail`. `publication` is the publication state the studio showed
 * (StudioCourse.publication); a publish or withdrawal made elsewhere since then is a conflict.
 */
export async function publishCourse(
  pool: Pool,
  actor: Actor,
  input: { id: string; revisionId: string; publication: number },
): Promise<CourseResult<{ revisionId: string }>> {
  return inTransaction(pool, async (c) => {
    const course = await lockCourse(c, input.id);
    if (!course || !canManageCourse(actor, ownerOf(course))) return { ok: false, error: "not_found" } as const;
    if (course.draft_revision_id !== input.revisionId || course.publication !== input.publication) {
      return { ok: false, error: "conflict" } as const;
    }
    // The lessons' articles are locked too, so one can't be withdrawn while this checks them.
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT i.id FROM course_lessons l JOIN content_items i ON i.id = l.item_id
         WHERE l.revision_id = $1 ORDER BY i.id FOR SHARE OF i) x`,
      [input.revisionId],
    );
    if (rows[0]!.n === 0) return { ok: false, error: "empty_course" } as const;
    const blocked = await unavailableLessons(c, input.revisionId);
    if (blocked.length) return { ok: false, error: "lesson_unavailable", detail: blocked.join(", ") } as const;
    await c.query(
      `UPDATE courses SET published_revision_id = $2, published_at = now(), withdrawn_at = NULL,
              publication = publication + 1, updated_at = now()
       WHERE id = $1`,
      [course.id, input.revisionId],
    );
    await audit(c, actor, "course.published", course.id, input.revisionId);
    return { ok: true, revisionId: input.revisionId } as const;
  });
}

/** Take the course offline. `publication` is the publication state the studio showed, as for publishCourse. */
export async function withdrawCourse(
  pool: Pool,
  actor: Actor,
  input: { id: string; publication: number },
): Promise<CourseResult<object>> {
  return inTransaction(pool, async (c) => {
    const course = await lockCourse(c, input.id);
    if (!course || !canManageCourse(actor, ownerOf(course))) return { ok: false, error: "not_found" } as const;
    if (course.publication !== input.publication) return { ok: false, error: "conflict" } as const;
    if (!course.published_revision_id) return { ok: false, error: "not_published" } as const;
    await c.query(
      `UPDATE courses SET published_revision_id = NULL, published_at = NULL, withdrawn_at = now(),
              publication = publication + 1, updated_at = now()
       WHERE id = $1`,
      [course.id],
    );
    await audit(c, actor, "course.withdrawn", course.id, course.published_revision_id);
    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Studio reads

export interface StudioCourseSummary {
  id: string;
  slug: string;
  title: string;
  status: CourseStatus;
  updatedAt: Date;
}

/** The studio's course list, most recently changed first, one page at a time (keyset on updated_at, id). */
export async function listStudioCourses(
  pool: Pick<Pool, "query">,
  actor: Actor,
  opts: { after?: string | null; limit?: number } = {},
): Promise<Page<StudioCourseSummary>> {
  const limit = opts.limit ?? PAGE_SIZE.studio;
  const after = decodeCursor(opts.after);
  const { rows } = await pool.query<CourseRow & { title: string; at_key: string }>(
    `SELECT c.*, c.updated_at::text AS at_key, r.title FROM courses c JOIN course_revisions r ON r.id = c.draft_revision_id
     WHERE ($1::boolean OR c.owner_subject = $2)
       AND ($3::timestamptz IS NULL OR (c.updated_at, c.id) < ($3::timestamptz, $4::text))
     ORDER BY c.updated_at DESC, c.id DESC LIMIT $5`,
    [seesAllCourses(actor), actor.subject, after?.at ?? null, after?.id ?? null, limit + 1],
  );
  return pageOf(
    rows,
    limit,
    (r) => r.at_key,
    (r) => ({ id: r.id, slug: r.slug, title: r.title, status: statusOf(r), updatedAt: r.updated_at }),
  );
}

export interface StudioLesson {
  lessonId: string;
  title: string;
  articleSlug: string;
  /** ok: pinned to the article's current published revision; outdated: a newer one is published; unavailable: not public now. */
  state: "ok" | "outdated" | "unavailable";
  pinnedNumber: number;
}

export interface StudioCourse {
  id: string;
  slug: string;
  status: CourseStatus;
  draftRevisionId: string;
  publishedRevisionId: string | null;
  draftIsPublished: boolean;
  /** The publication state shown: publish and withdraw forms send it back, so a stale one is refused. */
  publication: number;
  title: string;
  summary: string;
  modules: { title: string; lessons: StudioLesson[] }[];
}

export async function getStudioCourse(
  pool: Pick<Pool, "query">,
  actor: Actor,
  id: string,
): Promise<StudioCourse | null> {
  const course = (await pool.query<CourseRow>("SELECT * FROM courses WHERE id = $1", [id])).rows[0];
  if (!course || !canManageCourse(actor, ownerOf(course))) return null;
  const draft = await readDraft(pool, course.draft_revision_id);
  const ids = draft.modules.flatMap((m) => m.lessons.map((l) => l.lessonId));
  const { rows } = await pool.query<{
    lesson_id: string;
    title: string;
    number: number;
    slug: string;
    item_revision_id: string;
    published_revision_id: string | null;
  }>(
    `SELECT l.lesson_id, r.title, r.number, i.slug, l.item_revision_id, i.published_revision_id
     FROM course_lessons l JOIN content_revisions r ON r.id = l.item_revision_id JOIN content_items i ON i.id = l.item_id
     WHERE l.revision_id = $1 AND l.lesson_id = ANY($2::text[])`,
    [course.draft_revision_id, ids],
  );
  const byId = new Map(rows.map((r) => [r.lesson_id, r]));
  return {
    id: course.id,
    slug: course.slug,
    status: statusOf(course),
    draftRevisionId: course.draft_revision_id,
    publishedRevisionId: course.published_revision_id,
    draftIsPublished: course.published_revision_id === course.draft_revision_id,
    publication: course.publication,
    title: draft.title,
    summary: draft.summary,
    modules: draft.modules.map((m) => ({
      title: m.title,
      lessons: m.lessons.map((l) => {
        const r = byId.get(l.lessonId)!;
        return {
          lessonId: l.lessonId,
          title: r.title,
          articleSlug: r.slug,
          pinnedNumber: r.number,
          state: !r.published_revision_id
            ? "unavailable"
            : r.published_revision_id === r.item_revision_id
              ? "ok"
              : "outdated",
        } satisfies StudioLesson;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Public reads: published course revisions only, and only lessons whose article is public now.

export interface PublishedCourseSummary {
  slug: string;
  title: string;
  summary: string;
  publishedAt: Date;
  lessons: number;
}

/** Published courses, newest first, one page at a time (keyset on published_at, id). */
export async function listPublishedCourses(
  pool: Pick<Pool, "query">,
  opts: { after?: string | null; limit?: number } = {},
): Promise<Page<PublishedCourseSummary>> {
  const limit = opts.limit ?? PAGE_SIZE.public;
  const after = decodeCursor(opts.after);
  const { rows } = await pool.query<{
    id: string;
    at_key: string;
    slug: string;
    title: string;
    summary: string;
    published_at: Date;
    lessons: number;
  }>(
    `SELECT c.id, c.published_at::text AS at_key, c.slug, r.title, r.summary, c.published_at,
            (SELECT count(*)::int FROM course_lessons l JOIN content_items i ON i.id = l.item_id
             WHERE l.revision_id = r.id AND i.published_revision_id IS NOT NULL) AS lessons
     FROM courses c JOIN course_revisions r ON r.id = c.published_revision_id
     WHERE ($1::timestamptz IS NULL OR (c.published_at, c.id) < ($1::timestamptz, $2::text))
     ORDER BY c.published_at DESC, c.id DESC LIMIT $3`,
    [after?.at ?? null, after?.id ?? null, limit + 1],
  );
  return pageOf(
    rows,
    limit,
    (r) => r.at_key,
    (r) => ({ slug: r.slug, title: r.title, summary: r.summary, publishedAt: r.published_at, lessons: r.lessons }),
  );
}

export interface OutlineLesson {
  lessonId: string;
  title: string;
}

export interface PublishedCourse {
  slug: string;
  title: string;
  summary: string;
  publishedAt: Date;
  modules: { title: string; lessons: OutlineLesson[] }[];
}

interface OutlineRow {
  course_slug: string;
  course_title: string;
  course_summary: string;
  published_at: Date;
  module_position: number | null;
  module_title: string | null;
  lesson_id: string | null;
  lesson_title: string | null;
}

/** The published course and its outline: modules with at least one lesson a guest may open, in order. */
export async function getPublishedCourse(pool: Pick<Pool, "query">, slug: string): Promise<PublishedCourse | null> {
  const { rows } = await pool.query<OutlineRow>(
    `SELECT c.slug AS course_slug, cr.title AS course_title, cr.summary AS course_summary, c.published_at,
            m.position AS module_position, m.title AS module_title, l.lesson_id, r.title AS lesson_title
     FROM courses c JOIN course_revisions cr ON cr.id = c.published_revision_id
     LEFT JOIN course_modules m ON m.revision_id = cr.id
     LEFT JOIN course_lessons l ON l.revision_id = cr.id AND l.module_position = m.position
       AND EXISTS (SELECT 1 FROM content_items i WHERE i.id = l.item_id AND i.published_revision_id IS NOT NULL)
     LEFT JOIN content_revisions r ON r.id = l.item_revision_id
     WHERE c.slug = $1
     ORDER BY m.position, l.position`,
    [slug],
  );
  const first = rows[0];
  if (!first) return null;
  const modules: PublishedCourse["modules"] = [];
  let current = null as { position: number; title: string; lessons: OutlineLesson[] } | null;
  for (const r of rows) {
    if (r.module_position === null || !r.lesson_id) continue;
    if (current?.position !== r.module_position) {
      current = { position: r.module_position, title: r.module_title!, lessons: [] };
      modules.push(current);
    }
    current.lessons.push({ lessonId: r.lesson_id, title: r.lesson_title! });
  }
  return {
    slug: first.course_slug,
    title: first.course_title,
    summary: first.course_summary,
    publishedAt: first.published_at,
    modules: modules.map(({ title, lessons }) => ({ title, lessons })),
  };
}

export interface PublishedLesson {
  course: PublishedCourse;
  lessonId: string;
  moduleTitle: string;
  /** The article's current address: the canonical URL of this content. */
  articleSlug: string;
  title: string;
  summary: string;
  format: RevisionFormat;
  doc: Doc | null;
  body: string;
  prev: OutlineLesson | null;
  next: OutlineLesson | null;
}

/** One lesson of a published course, at its pinned revision; null when the lesson isn't visible to guests. */
export async function getPublishedLesson(
  pool: Pick<Pool, "query">,
  slug: string,
  lessonId: string,
): Promise<PublishedLesson | null> {
  const course = await getPublishedCourse(pool, slug);
  if (!course) return null;
  const flat = course.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, moduleTitle: m.title })));
  const at = flat.findIndex((l) => l.lessonId === lessonId);
  if (at < 0) return null;
  const { rows } = await pool.query<{
    slug: string;
    title: string;
    summary: string;
    format: RevisionFormat;
    doc: Doc | null;
    body: string;
  }>(
    `SELECT i.slug, r.title, r.summary, r.format, r.doc, r.body
     FROM courses c JOIN course_lessons l ON l.revision_id = c.published_revision_id
     JOIN content_items i ON i.id = l.item_id AND i.published_revision_id IS NOT NULL
     JOIN content_revisions r ON r.id = l.item_revision_id
     WHERE c.slug = $1 AND l.lesson_id = $2`,
    [slug, lessonId],
  );
  const r = rows[0];
  if (!r) return null;
  const strip = (l: (typeof flat)[number] | undefined) => (l ? { lessonId: l.lessonId, title: l.title } : null);
  return {
    course,
    lessonId,
    moduleTitle: flat[at]!.moduleTitle,
    articleSlug: r.slug,
    title: r.title,
    summary: r.summary,
    format: r.format,
    doc: r.doc,
    body: r.body,
    prev: strip(flat[at - 1]),
    next: strip(flat[at + 1]),
  };
}

/** The articles a lesson can be made from: the published ones, for the studio's picker. */
export async function listLessonChoices(pool: Pick<Pool, "query">): Promise<{ slug: string; title: string }[]> {
  const { rows } = await pool.query<{ slug: string; title: string }>(
    `SELECT i.slug, r.title FROM content_items i JOIN content_revisions r ON r.id = i.published_revision_id
     ORDER BY r.title LIMIT 500`,
  );
  return rows;
}
