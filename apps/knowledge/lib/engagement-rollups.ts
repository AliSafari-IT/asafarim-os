/**
 * Like and comment counts for lessons, modules and courses (the engagement module, @asafarim/engagement).
 *
 * People like and comment on LESSONS (entity type "lesson", id = the lesson id, stable across a course's revisions).
 * The counts roll up: a lesson's own counts live in `engagement_rollups` ('lesson', lessonId), its module's in
 * `engagement_rollups` ('module', "<courseId>:<modulePosition>") and its course's in `courses.likes_count` /
 * `courses.comments_count`. Course revisions are immutable (DB triggers), so none of this can live on them.
 *
 * The invariant: a module's and a course's counts are the sums of the lesson counts of the lessons in the course's
 * PUBLISHED revision. `onCountChange` keeps it for every like and comment, inside the write's own transaction, and
 * `recountCourseEngagement` restores it when another revision is published (lessons moved, added or removed).
 * Every write to a course's rollups holds that course's row lock, so a like and a publish can't interleave.
 */
import type pg from "pg";

type Client = Pick<pg.PoolClient, "query">;

export type Metric = "likes" | "comments";

/** Only these two column names are ever interpolated into SQL. */
const COLUMN: Record<Metric, "likes_count" | "comments_count"> = {
  likes: "likes_count",
  comments: "comments_count",
};

export const moduleKey = (courseId: string, position: number) => `${courseId}:${position}`;

async function bump(c: Client, entityType: "lesson" | "module", entityId: string, metric: Metric, delta: number) {
  const col = COLUMN[metric];
  await c.query(
    `INSERT INTO engagement_rollups (entity_type, entity_id, ${col}) VALUES ($1, $2, GREATEST($3::int, 0))
     ON CONFLICT (entity_type, entity_id)
     DO UPDATE SET ${col} = GREATEST(engagement_rollups.${col} + $3::int, 0), updated_at = now()`,
    [entityType, entityId, delta],
  );
}

/**
 * The `onCountChange` hook: called by @asafarim/engagement inside the like's or comment's transaction. Throwing
 * rolls the like or comment back, so it only throws when the database does.
 */
export async function applyCountChange(
  c: Client,
  entityType: string,
  entityId: string,
  metric: Metric,
  delta: number,
): Promise<void> {
  if (entityType !== "lesson" || delta === 0) return;
  // The course a lesson belongs to never changes (its id is minted for one course), so any revision names it.
  const owner = await c.query<{ course_id: string }>(
    `SELECT cr.course_id FROM course_lessons l JOIN course_revisions cr ON cr.id = l.revision_id
     WHERE l.lesson_id = $1 LIMIT 1`,
    [entityId],
  );
  const courseId = owner.rows[0]?.course_id;
  if (!courseId) {
    await bump(c, "lesson", entityId, metric, delta);
    return;
  }
  // Lock the course first: a publish (which recounts) waits for this, or this waits for it and then sees the
  // revision it published.
  const course = await c.query<{ published_revision_id: string | null }>(
    "SELECT published_revision_id FROM courses WHERE id = $1 FOR UPDATE",
    [courseId],
  );
  await bump(c, "lesson", entityId, metric, delta);
  const revisionId = course.rows[0]?.published_revision_id;
  if (!revisionId) return; // withdrawn: the course and modules are recounted when it is published again
  const at = await c.query<{ module_position: number }>(
    "SELECT module_position FROM course_lessons WHERE revision_id = $1 AND lesson_id = $2",
    [revisionId, entityId],
  );
  const position = at.rows[0]?.module_position;
  if (position === undefined) return; // not in the published revision: it doesn't count towards the course
  await bump(c, "module", moduleKey(courseId, position), metric, delta);
  const col = COLUMN[metric];
  await c.query(`UPDATE courses SET ${col} = GREATEST(${col} + $2::int, 0) WHERE id = $1`, [courseId, delta]);
}

/**
 * Make the course's and its modules' counts the sums of the lesson counts of `revisionId` (the revision being
 * published). Call it in the publishing transaction, with the course row locked.
 */
export async function recountCourseEngagement(c: Client, courseId: string, revisionId: string): Promise<void> {
  await c.query("DELETE FROM engagement_rollups WHERE entity_type = 'module' AND starts_with(entity_id, $1)", [
    `${courseId}:`,
  ]);
  await c.query(
    `INSERT INTO engagement_rollups (entity_type, entity_id, likes_count, comments_count)
     SELECT 'module', $1 || ':' || l.module_position, sum(r.likes_count), sum(r.comments_count)
     FROM course_lessons l
     JOIN engagement_rollups r ON r.entity_type = 'lesson' AND r.entity_id = l.lesson_id
     WHERE l.revision_id = $2
     GROUP BY l.module_position`,
    [courseId, revisionId],
  );
  await c.query(
    `UPDATE courses SET
       likes_count = COALESCE(x.likes, 0), comments_count = COALESCE(x.comments, 0)
     FROM (SELECT sum(r.likes_count)::int AS likes, sum(r.comments_count)::int AS comments
           FROM course_lessons l
           JOIN engagement_rollups r ON r.entity_type = 'lesson' AND r.entity_id = l.lesson_id
           WHERE l.revision_id = $2) x
     WHERE courses.id = $1`,
    [courseId, revisionId],
  );
}

export interface Counts {
  likes: number;
  comments: number;
}

export interface CourseCounts {
  course: Counts;
  /** By module position. */
  modules: Map<number, Counts>;
  /** By lesson id. */
  lessons: Map<string, Counts>;
}

const ZERO: Counts = { likes: 0, comments: 0 };
export const countsOf = <K>(m: Map<K, Counts>, k: K): Counts => m.get(k) ?? ZERO;

/** The counts a published course page shows: the course's, each module's and each lesson's. */
export async function courseCounts(
  pool: Pick<pg.Pool, "query">,
  course: { id: string; modules: { lessons: { lessonId: string }[] }[] },
): Promise<CourseCounts> {
  const lessonIds = course.modules.flatMap((m) => m.lessons.map((l) => l.lessonId));
  const [own, rows] = await Promise.all([
    pool.query<{ likes_count: number; comments_count: number }>(
      "SELECT likes_count, comments_count FROM courses WHERE id = $1",
      [course.id],
    ),
    pool.query<{ entity_type: string; entity_id: string; likes_count: number; comments_count: number }>(
      `SELECT entity_type, entity_id, likes_count, comments_count FROM engagement_rollups
       WHERE (entity_type = 'lesson' AND entity_id = ANY($1::text[]))
          OR (entity_type = 'module' AND starts_with(entity_id, $2))`,
      [lessonIds, `${course.id}:`],
    ),
  ]);
  const modules = new Map<number, Counts>();
  const lessons = new Map<string, Counts>();
  for (const r of rows.rows) {
    const counts = { likes: r.likes_count, comments: r.comments_count };
    if (r.entity_type === "lesson") lessons.set(r.entity_id, counts);
    else {
      const position = Number(r.entity_id.slice(course.id.length + 1));
      if (Number.isInteger(position)) modules.set(position, counts);
    }
  }
  const c = own.rows[0];
  return { course: c ? { likes: c.likes_count, comments: c.comments_count } : ZERO, modules, lessons };
}

/** Whether a lesson may be liked or commented on: it is in a published course and its article is public. */
export async function isEngageableLesson(pool: Pick<pg.Pool, "query">, lessonId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM courses c
     JOIN course_lessons l ON l.revision_id = c.published_revision_id AND l.lesson_id = $1
     JOIN content_items i ON i.id = l.item_id AND i.published_revision_id IS NOT NULL
     LIMIT 1`,
    [lessonId],
  );
  return (rowCount ?? 0) > 0;
}

/** The course a lesson belongs to (any revision names it: a lesson id is minted for one course), or null. */
export async function lessonCourseId(c: Pick<pg.Pool, "query">, lessonId: string): Promise<string | null> {
  const { rows } = await c.query<{ course_id: string }>(
    "SELECT cr.course_id FROM course_lessons l JOIN course_revisions cr ON cr.id = l.revision_id WHERE l.lesson_id = $1 LIMIT 1",
    [lessonId],
  );
  return rows[0]?.course_id ?? null;
}

/** The owner of the course a lesson belongs to (for the "instructor" badge), or null. */
export async function lessonCourseOwner(pool: Pick<pg.Pool, "query">, lessonId: string): Promise<string | null> {
  const { rows } = await pool.query<{ owner_subject: string }>(
    `SELECT c.owner_subject FROM course_lessons l
     JOIN course_revisions cr ON cr.id = l.revision_id JOIN courses c ON c.id = cr.course_id
     WHERE l.lesson_id = $1 LIMIT 1`,
    [lessonId],
  );
  return rows[0]?.owner_subject ?? null;
}
