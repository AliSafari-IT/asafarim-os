/**
 * Retention: a step's `input` and `output` may hold what the acting app sent (a drafted issue, for
 * one), so they are cleared 30 days after the run ended. The metadata stays: statuses, timing, ids
 * and error codes.
 */
import type { Tx } from "./store";

export const RETENTION_DAYS = 30;

/** Clear the payloads of steps whose run ended more than `days` before `now`; how many steps changed. */
export async function clearOldPayloads(tx: Tx, now: Date, days = RETENTION_DAYS): Promise<number> {
  const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const r = (await tx.query(
    `UPDATE workflow_run_steps s SET input = NULL, output = NULL
       FROM workflow_runs r
      WHERE s.run_id = r.id AND r.ended_at < $1 AND (s.input IS NOT NULL OR s.output IS NOT NULL)`,
    [before],
  )) as { rowCount: number | null };
  return r.rowCount ?? 0;
}
