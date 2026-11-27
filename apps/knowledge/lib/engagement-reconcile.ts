/**
 * The nightly recount of like and comment counts (engagement Phase 4): the counts are kept exact in every write's
 * transaction (lib/engagement-rollups.ts), so this normally changes nothing. It heals what a bug, a manual database
 * edit or a restored backup could leave: every lesson's counts are recounted from engagement_likes and the visible
 * rows of engagement_comments, then every published course and its modules from its lessons.
 *
 * One instance runs it at a time (advisory lock); it runs in one transaction, so readers see the old counts or the
 * new ones, never a mix. Returns how many lesson rows changed.
 */
import type pg from "pg";
import { recountCourseEngagement } from "./engagement-rollups";

export const RECONCILE_EVERY_MS = 24 * 3600_000;

export async function reconcileEngagement(
  pool: Pick<pg.Pool, "connect">,
): Promise<{ lessons: number; courses: number }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows: lock } = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('knowledge.engagement.reconcile')) AS ok",
    );
    if (!lock[0]?.ok) {
      await c.query("ROLLBACK");
      return { lessons: 0, courses: 0 };
    }
    // The true counts of every lesson that has (or had) any.
    const changed = await c.query(
      `WITH truth AS (
         SELECT entity_id, sum(likes)::int AS likes, sum(comments)::int AS comments FROM (
           SELECT entity_id, count(*) AS likes, 0 AS comments FROM engagement_likes
            WHERE entity_type = 'lesson' GROUP BY entity_id
           UNION ALL
           SELECT entity_id, 0, count(*) FROM engagement_comments
            WHERE entity_type = 'lesson' AND status = 'visible' GROUP BY entity_id
           UNION ALL
           SELECT entity_id, 0, 0 FROM engagement_rollups WHERE entity_type = 'lesson'
         ) x GROUP BY entity_id
       )
       INSERT INTO engagement_rollups (entity_type, entity_id, likes_count, comments_count)
       SELECT 'lesson', entity_id, likes, comments FROM truth
       ON CONFLICT (entity_type, entity_id) DO UPDATE
         SET likes_count = EXCLUDED.likes_count, comments_count = EXCLUDED.comments_count, updated_at = now()
         WHERE engagement_rollups.likes_count IS DISTINCT FROM EXCLUDED.likes_count
            OR engagement_rollups.comments_count IS DISTINCT FROM EXCLUDED.comments_count`,
    );
    // Every published course, locked as a publish would lock it, then recounted from its lessons.
    const { rows: courses } = await c.query<{ id: string; published_revision_id: string }>(
      "SELECT id, published_revision_id FROM courses WHERE published_revision_id IS NOT NULL ORDER BY id FOR UPDATE",
    );
    for (const course of courses) await recountCourseEngagement(c, course.id, course.published_revision_id);
    await c.query("COMMIT");
    return { lessons: changed.rowCount ?? 0, courses: courses.length };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Once a day, in the server process, when likes and comments are on. A failed run is logged; the next one retries. */
export function scheduleEngagementReconcile(getPool: () => Promise<pg.Pool>): void {
  const run = async () => {
    try {
      const result = await reconcileEngagement(await getPool());
      if (result.lessons) console.info(JSON.stringify({ app: "knowledge", msg: "engagement.reconciled", ...result }));
    } catch (err) {
      console.warn(
        JSON.stringify({
          app: "knowledge",
          msg: "engagement.reconcile_failed",
          error: err instanceof Error ? err.message : "error",
        }),
      );
    }
  };
  setInterval(run, RECONCILE_EVERY_MS).unref();
}
