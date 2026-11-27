import type pg from "pg";
import type { PublishedCourse } from "./courses";

type Client = Pick<pg.Pool, "query">;
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

/** One indexed read for all distinct articles in the outline. */
export async function articleCounts(pool: Client, ids: string[]): Promise<Map<string, Counts>> {
  const result = await pool.query<{ entity_id: string; likes: number; comments: number }>(
    `SELECT entity_id, likes_count AS likes, comments_count AS comments
     FROM engagement_rollups WHERE entity_type = 'article' AND entity_id = ANY($1::text[])`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.entity_id, { likes: row.likes, comments: row.comments }]));
}

export async function applyCountChange(
  pool: Client,
  type: string,
  id: string,
  metric: "likes" | "comments",
  delta: number,
) {
  if (type !== "article" || !delta) return;
  const col = metric === "likes" ? "likes_count" : "comments_count";
  await pool.query(
    `INSERT INTO engagement_rollups(entity_type,entity_id,${col}) VALUES ('article',$1,GREATEST($2::int,0))
     ON CONFLICT(entity_type,entity_id) DO UPDATE SET ${col}=GREATEST(0,engagement_rollups.${col}+$2::int),updated_at=now()`,
    [id, delta],
  );
}

export async function courseCounts(pool: Client, course: PublishedCourse): Promise<CourseCounts> {
  const ids = new Set(course.modules.flatMap((m) => m.lessons.map((l) => l.itemId)));
  const articles = await articleCounts(pool, [...ids]);
  const sum = (keys: Set<string>) => {
    const total = { likes: 0, comments: 0 };
    for (const id of keys) {
      const counts = countsOf(articles, id);
      total.likes += counts.likes;
      total.comments += counts.comments;
    }
    return total;
  };
  const lessons = new Map<string, Counts>();
  const modules = new Map<number, Counts>();
  for (const module of course.modules) {
    for (const lesson of module.lessons) lessons.set(lesson.lessonId, countsOf(articles, lesson.itemId));
    modules.set(module.position, sum(new Set(module.lessons.map((l) => l.itemId))));
  }
  return { course: sum(ids), modules, lessons };
}

export async function isPublicArticle(pool: Client, id: string) {
  const result = await pool.query("SELECT 1 FROM content_items WHERE id=$1 AND published_revision_id IS NOT NULL", [
    id,
  ]);
  return !!result.rowCount;
}

/** Existing lesson API clients reach the same thread while the lesson is public. */
export async function resolveLessonArticle(pool: Client, id: string) {
  const result = await pool.query<{ item_id: string }>(
    `SELECT l.item_id FROM courses c JOIN course_lessons l ON l.revision_id=c.published_revision_id
     JOIN content_items i ON i.id=l.item_id AND i.published_revision_id IS NOT NULL
     WHERE l.lesson_id=$1 LIMIT 1`,
    [id],
  );
  const item = result.rows[0];
  return item ? { entityType: "article", entityId: item.item_id } : null;
}
