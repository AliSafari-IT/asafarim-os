/**
 * Retention: a step's `input` and `output` may hold what the acting app sent (a drafted issue, for
 * one), and an approval's `edited` and `comment` what the approver wrote, so they are cleared 30 days
 * after the run ended. The metadata stays: statuses, timing, ids, who decided and error codes. The email
 * rate limit's rows (`email_sends`) count for a day; they go after two.
 */
import type { Tx } from "./store";

export const RETENTION_DAYS = 30;

/** Clear the payloads of steps (and approvals) whose run ended more than `days` before `now`; how many steps changed. */
export async function clearOldPayloads(tx: Tx, now: Date, days = RETENTION_DAYS): Promise<number> {
  const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const r = (await tx.query(
    `UPDATE workflow_run_steps s SET input = NULL, output = NULL
       FROM workflow_runs r
      WHERE s.run_id = r.id AND r.ended_at < $1 AND (s.input IS NOT NULL OR s.output IS NOT NULL)`,
    [before],
  )) as { rowCount: number | null };
  await tx.query(
    `UPDATE approvals a SET edited = NULL, comment = NULL
       FROM workflow_runs r
      WHERE a.run_id = r.id AND r.ended_at < $1 AND (a.edited IS NOT NULL OR a.comment IS NOT NULL)`,
    [before],
  );
  await tx.query("DELETE FROM email_sends WHERE created_at < $1", [new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)]);
  return r.rowCount ?? 0;
}
