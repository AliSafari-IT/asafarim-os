/** What the pages read (server only). Every caller has checked `flow.read` first (lib/gate.ts). */
import type pg from "pg";
import { approvalFrom, runFrom, stepFrom, versionFrom } from "./engine/pg-store";
import type { ApprovalRow, RunRow, StepRow, VersionRow, WorkflowStatus } from "./engine/store";
import { Draft } from "./workflow/approval";
import type { AnyWorkflowDefinition } from "./workflow/definition";
import { graphOf, type GraphNode } from "./workflow/graph";

export interface RunSummary extends RunRow {
  workflowKey: string;
  /** The version the run is pinned to; null for a test run of a draft. */
  version: number | null;
  /** The step the run is at (the last one it reached). */
  currentStep: string | null;
}

const SUMMARY = `
  SELECT r.*, w.key AS workflow_key, v.version AS version_number,
         (SELECT s.step_key FROM workflow_run_steps s WHERE s.run_id = r.id ORDER BY s.seq DESC LIMIT 1) AS current_step
    FROM workflow_runs r
    JOIN workflows w ON w.id = r.workflow_id
    LEFT JOIN workflow_versions v ON v.id = r.version_id`;

const summaryFrom = (r: Record<string, unknown>): RunSummary => ({
  ...runFrom(r),
  workflowKey: r.workflow_key as string,
  version: (r.version_number as number | null) ?? null,
  currentStep: (r.current_step as string | null) ?? null,
});

export async function overview(p: pg.Pool, now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [waiting, failures, latest, approvals] = await Promise.all([
    p.query(`${SUMMARY} WHERE r.status = 'waiting' ORDER BY r.started_at DESC LIMIT 50`),
    p.query(`${SUMMARY} WHERE r.status = 'failed' AND r.ended_at >= $1 ORDER BY r.ended_at DESC LIMIT 50`, [weekAgo]),
    p.query(`${SUMMARY} ORDER BY r.started_at DESC LIMIT 10`),
    p.query("SELECT count(*)::int AS n FROM approvals WHERE status = 'pending' AND deadline > $1", [now]),
  ]);
  return {
    pendingApprovals: approvals.rows[0].n as number,
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
): Promise<
  { run: RunSummary; definition: AnyWorkflowDefinition; steps: StepRow[]; approvals: ApprovalRow[] } | undefined
> {
  const { rows } = await p.query(`${SUMMARY} WHERE r.id = $1`, [id]);
  if (!rows[0]) return undefined;
  const run = summaryFrom(rows[0]);
  const [version, steps, approvals] = await Promise.all([
    run.versionId ? p.query("SELECT * FROM workflow_versions WHERE id = $1", [run.versionId]) : undefined,
    p.query("SELECT * FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq", [id]),
    p.query("SELECT * FROM approvals WHERE run_id = $1 ORDER BY created_at, id", [id]),
  ]);
  return {
    run,
    // The draft a test run carries, or its version's.
    definition: run.draftDefinition ?? versionFrom(version!.rows[0]).definition,
    steps: steps.rows.map(stepFrom),
    approvals: approvals.rows.map(approvalFrom),
  };
}

export interface PendingApproval {
  id: string;
  runId: string;
  workflowKey: string;
  createdAt: Date;
  deadline: Date | null;
  /** From the draft (the step's input); undefined when it isn't one. */
  docPath?: string;
  repo?: string;
}

/** Pending approvals still before their deadline, oldest first. */
export async function listPendingApprovals(p: pg.Pool, now = new Date(), limit = 100): Promise<PendingApproval[]> {
  const { rows } = await p.query(
    `SELECT a.id, a.run_id, a.created_at, a.deadline, s.input, w.key AS workflow_key
       FROM approvals a
       JOIN workflow_run_steps s ON s.id = a.step_id
       JOIN workflow_runs r ON r.id = a.run_id
       JOIN workflows w ON w.id = r.workflow_id
      WHERE a.status = 'pending' AND a.deadline > $1
      ORDER BY a.created_at, a.id
      LIMIT $2`,
    [now, limit],
  );
  return rows.map((r) => {
    const draft = Draft.safeParse(r.input);
    return {
      id: r.id,
      runId: r.run_id,
      workflowKey: r.workflow_key,
      createdAt: r.created_at,
      deadline: r.deadline,
      ...(draft.success ? { docPath: draft.data.docPath, repo: draft.data.repo } : {}),
    };
  });
}

export interface ApprovalView {
  approval: ApprovalRow;
  run: RunSummary;
  /** The step's node: its role, deadline, editable fields and whether it reviews a draft. */
  step: Extract<GraphNode, { kind: "approval" }>;
  /** The draft shown (the step's input); undefined once retention cleared it. */
  draft?: Draft;
}

export async function getApproval(p: pg.Pool, id: string): Promise<ApprovalView | undefined> {
  const { rows } = await p.query(
    "SELECT a.*, s.input AS step_input, s.step_key AS step_key FROM approvals a JOIN workflow_run_steps s ON s.id = a.step_id WHERE a.id = $1",
    [id],
  );
  const r = rows[0];
  if (!r) return undefined;
  const approval = approvalFrom(r);
  const found = await getRun(p, approval.runId);
  const step = found ? graphOf(found.definition).nodes.get(r.step_key) : undefined;
  if (!found || step?.kind !== "approval") return undefined;
  const draft = Draft.safeParse(r.step_input);
  return { approval, run: found.run, step, ...(draft.success ? { draft: draft.data } : {}) };
}

export interface WorkflowView {
  key: string;
  name: string;
  status: WorkflowStatus;
  /** The published version runs start on; null for a workflow that only has a draft so far. */
  current: VersionRow | null;
  versions: number;
  /** When the unpublished draft was saved; null without one. */
  draftUpdatedAt: Date | null;
}

export async function listWorkflows(p: pg.Pool): Promise<WorkflowView[]> {
  const { rows } = await p.query(
    `SELECT w.key AS w_key, w.name AS w_name, w.status AS w_status, w.draft_updated_at AS w_draft_updated_at, v.*,
            (SELECT count(*) FROM workflow_versions x WHERE x.workflow_id = w.id)::int AS versions
       FROM workflows w
       LEFT JOIN LATERAL (SELECT * FROM workflow_versions WHERE workflow_id = w.id ORDER BY version DESC LIMIT 1) v ON true
      ORDER BY w.key`,
  );
  return rows.map((r) => ({
    key: r.w_key,
    name: r.w_name,
    status: r.w_status,
    current: r.id ? versionFrom(r) : null,
    versions: r.versions,
    draftUpdatedAt: r.w_draft_updated_at ?? null,
  }));
}

export interface BuilderWorkflow {
  id: string;
  key: string;
  name: string;
  status: WorkflowStatus;
  /** The unpublished draft as saved (any JSON); null without one. */
  draft: unknown;
  draftUpdatedAt: Date | null;
  draftUpdatedBy: string | null;
  /** The published versions, newest first; the definition of the newest only. */
  versions: { version: number; publishedAt: Date }[];
  current: VersionRow | null;
}

/** A workflow as the builder opens it. */
export async function getBuilderWorkflow(p: pg.Pool, key: string): Promise<BuilderWorkflow | undefined> {
  const { rows } = await p.query("SELECT * FROM workflows WHERE key = $1", [key]);
  const w = rows[0];
  if (!w) return undefined;
  const [versions, current] = await Promise.all([
    p.query("SELECT version, published_at FROM workflow_versions WHERE workflow_id = $1 ORDER BY version DESC", [w.id]),
    p.query("SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY version DESC LIMIT 1", [w.id]),
  ]);
  return {
    id: w.id,
    key: w.key,
    name: w.name,
    status: w.status,
    draft: w.draft_definition ?? null,
    draftUpdatedAt: w.draft_updated_at ?? null,
    draftUpdatedBy: w.draft_updated_by ?? null,
    versions: versions.rows.map((r) => ({ version: r.version, publishedAt: r.published_at })),
    current: current.rows[0] ? versionFrom(current.rows[0]) : null,
  };
}

/** Published versions of a workflow, by number: the ones asked for that exist. */
export async function getVersions(p: pg.Pool, key: string, numbers: readonly number[]): Promise<VersionRow[]> {
  const { rows } = await p.query(
    `SELECT v.* FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
      WHERE w.key = $1 AND v.version = ANY($2::int[]) ORDER BY v.version`,
    [key, [...numbers]],
  );
  return rows.map(versionFrom);
}
