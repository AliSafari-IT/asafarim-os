/** What the pages read (server only). Every caller has checked `flow.read` first (lib/gate.ts). */
import type pg from "pg";
import { runFrom, stepFrom, versionFrom } from "./engine/pg-store";
import type { RunRow, StepRow, VersionRow, WorkflowStatus } from "./engine/store";

export interface RunSummary extends RunRow {
  workflowKey: string;
  version: number;
  /** The step the run is at (the last one it reached). */
  currentStep: string | null;
}

const SUMMARY = `
  SELECT r.*, w.key AS workflow_key, v.version AS version_number,
         (SELECT s.step_key FROM workflow_run_steps s WHERE s.run_id = r.id ORDER BY s.seq DESC LIMIT 1) AS current_step
    FROM workflow_runs r
    JOIN workflow_versions v ON v.id = r.version_id
    JOIN workflows w ON w.id = v.workflow_id`;

const summaryFrom = (r: Record<string, unknown>): RunSummary => ({
  ...runFrom(r),
  workflowKey: r.workflow_key as string,
  version: r.version_number as number,
  currentStep: (r.current_step as string | null) ?? null,
});

export async function overview(p: pg.Pool, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [waiting, failures, latest] = await Promise.all([
    p.query(`${SUMMARY} WHERE r.status = 'waiting' ORDER BY r.started_at DESC LIMIT 50`),
    p.query(`${SUMMARY} WHERE r.status = 'failed' AND r.ended_at >= $1 ORDER BY r.ended_at DESC LIMIT 50`, [weekAgo]),
    p.query(`${SUMMARY} ORDER BY r.started_at DESC LIMIT 10`),
  ]);
  return {
    waiting: waiting.rows.map(summaryFrom),
    failures: failures.rows.map(summaryFrom),
    latest: latest.rows.map(summaryFrom),
  };
}

/** The newest runs, skipped ones only when asked for. */
export async function listRuns(p: pg.Pool, opts: { skipped: boolean; limit?: number }): Promise<RunSummary[]> {
  const where = opts.skipped ? "" : "WHERE r.status <> 'skipped'";
  const { rows } = await p.query(`${SUMMARY} ${where} ORDER BY r.started_at DESC LIMIT $1`, [opts.limit ?? 100]);
  return rows.map(summaryFrom);
}

export async function getRun(
  p: pg.Pool,
  id: string,
): Promise<{ run: RunSummary; version: VersionRow; steps: StepRow[] } | undefined> {
  const { rows } = await p.query(`${SUMMARY} WHERE r.id = $1`, [id]);
  if (!rows[0]) return undefined;
  const run = summaryFrom(rows[0]);
  const [version, steps] = await Promise.all([
    p.query("SELECT * FROM workflow_versions WHERE id = $1", [run.versionId]),
    p.query("SELECT * FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq", [id]),
  ]);
  return { run, version: versionFrom(version.rows[0]), steps: steps.rows.map(stepFrom) };
}

export interface WorkflowView {
  key: string;
  name: string;
  status: WorkflowStatus;
  current: VersionRow;
  versions: number;
}

export async function listWorkflows(p: pg.Pool): Promise<WorkflowView[]> {
  const { rows } = await p.query(
    `SELECT w.key AS w_key, w.name AS w_name, w.status AS w_status, v.*,
            (SELECT count(*) FROM workflow_versions x WHERE x.workflow_id = w.id)::int AS versions
       FROM workflows w
       JOIN LATERAL (SELECT * FROM workflow_versions WHERE workflow_id = w.id ORDER BY version DESC LIMIT 1) v ON true
      ORDER BY w.key`,
  );
  return rows.map((r) => ({
    key: r.w_key,
    name: r.w_name,
    status: r.w_status,
    current: versionFrom(r),
    versions: r.versions,
  }));
}
