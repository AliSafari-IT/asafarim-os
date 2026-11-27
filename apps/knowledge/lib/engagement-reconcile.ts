import type pg from "pg";

export const RECONCILE_EVERY_MS = 24 * 3600_000;

export async function reconcileEngagement(pool: Pick<pg.Pool, "connect">): Promise<{ articles: number }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows: lock } = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('knowledge.engagement.reconcile')) AS ok",
    );
    if (!lock[0]?.ok) {
      await c.query("ROLLBACK");
      return { articles: 0 };
    }
    // The true counts of every article that has (or had) any.
    await c.query("LOCK TABLE engagement_rollups IN SHARE ROW EXCLUSIVE MODE");
    const changed = await c.query(
      `WITH truth AS (
         SELECT entity_id, sum(likes)::int AS likes, sum(comments)::int AS comments FROM (
           SELECT entity_id, count(*) AS likes, 0 AS comments FROM engagement_likes
            WHERE entity_type = 'article' GROUP BY entity_id
           UNION ALL
           SELECT entity_id, 0, count(*) FROM engagement_comments
            WHERE entity_type = 'article' AND status = 'visible' GROUP BY entity_id
           UNION ALL
           SELECT entity_id, 0, 0 FROM engagement_rollups WHERE entity_type = 'article'
         ) x GROUP BY entity_id
       )
       INSERT INTO engagement_rollups (entity_type, entity_id, likes_count, comments_count)
       SELECT 'article', entity_id, likes, comments FROM truth
       ON CONFLICT (entity_type, entity_id) DO UPDATE
         SET likes_count = EXCLUDED.likes_count, comments_count = EXCLUDED.comments_count, updated_at = now()
         WHERE engagement_rollups.likes_count IS DISTINCT FROM EXCLUDED.likes_count
            OR engagement_rollups.comments_count IS DISTINCT FROM EXCLUDED.comments_count`,
    );
    await c.query("COMMIT");
    return { articles: changed.rowCount ?? 0 };
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
      if (result.articles) console.info(JSON.stringify({ app: "knowledge", msg: "engagement.reconciled", ...result }));
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
