/** The engine's store on Flow's own Postgres database (tables: lib/migrations.ts). */
import { parseDefinition } from "../workflow/definition";
import type {
  ApprovalPatch,
  ApprovalRow,
  FlowStore,
  RunPatch,
  RunRow,
  StepPatch,
  StepRow,
  Tx,
  VersionRow,
  WorkflowRow,
  WorkflowStatus,
} from "./store";

type Row = Record<string, unknown>;

async function rows(tx: Tx, text: string, values: unknown[] = []): Promise<Row[]> {
  return ((await tx.query(text, values)) as { rows: Row[] }).rows;
}

const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));

/** A stored definition: published (or a test run's), so it validated once; a connector gone since isn't a reason to refuse it. */
function storedDefinition(value: unknown, what: string) {
  const parsed = parseDefinition(value, { connectors: false });
  if (!parsed.ok) throw new Error(`${what} has an invalid definition: ${parsed.problems[0]}`);
  return parsed.definition;
}

export function versionFrom(r: Row): VersionRow {
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    version: r.version as number,
    definition: storedDefinition(r.definition, `workflow version ${String(r.id)}`),
    publishedAt: r.published_at as Date,
  };
}

export function runFrom(r: Row): RunRow {
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    versionId: (r.version_id as string | null) ?? null,
    draftDefinition: r.draft_definition ? storedDefinition(r.draft_definition, `run ${String(r.id)}`) : null,
    test: r.test === true,
    dryRun: r.dry_run === true,
    triggerEventId: r.trigger_event_id as string,
    trigger: r.trigger as Record<string, unknown>,
    status: r.status as RunRow["status"],
    startedAt: r.started_at as Date,
    endedAt: date(r.ended_at),
    errorCode: (r.error_code as string | null) ?? null,
  };
}

export function stepFrom(r: Row): StepRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    stepKey: r.step_key as string,
    status: r.status as StepRow["status"],
    requestEventId: (r.request_event_id as string | null) ?? null,
    outcomeEventId: (r.outcome_event_id as string | null) ?? null,
    input: r.input ?? null,
    output: r.output ?? null,
    attempts: r.attempts as number,
    autoRetries: (r.auto_retries as number | undefined) ?? 0,
    startedAt: date(r.started_at),
    endedAt: date(r.ended_at),
    timeoutAt: date(r.timeout_at),
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
  };
}

export function approvalFrom(r: Row): ApprovalRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    stepId: r.step_id as string,
    status: r.status as ApprovalRow["status"],
    assigneeRole: r.assignee_role as string,
    deadline: date(r.deadline),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: date(r.decided_at),
    comment: (r.comment as string | null) ?? null,
    edited: (r.edited as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

export const workflowFrom = (r: Row): WorkflowRow => ({
  id: r.id as string,
  key: r.key as string,
  name: r.name as string,
  status: r.status as WorkflowStatus,
  draftDefinition: r.draft_definition ?? null,
  draftUpdatedAt: date(r.draft_updated_at),
  draftUpdatedBy: (r.draft_updated_by as string | null) ?? null,
});

const RUN_COLUMNS: Record<keyof RunPatch, string> = { status: "status", endedAt: "ended_at", errorCode: "error_code" };
const STEP_COLUMNS: Record<keyof StepPatch, string> = {
  status: "status",
  requestEventId: "request_event_id",
  outcomeEventId: "outcome_event_id",
  input: "input",
  output: "output",
  attempts: "attempts",
  autoRetries: "auto_retries",
  startedAt: "started_at",
  endedAt: "ended_at",
  timeoutAt: "timeout_at",
  errorCode: "error_code",
  errorMessage: "error_message",
};
const APPROVAL_COLUMNS: Record<keyof ApprovalPatch, string> = {
  status: "status",
  decidedBy: "decided_by",
  decidedAt: "decided_at",
  comment: "comment",
  edited: "edited",
};
const JSON_COLUMNS = new Set(["input", "output", "edited"]);

/** `UPDATE <table> SET a = $2, b = $3 WHERE id = $1` from a patch; column names come from the maps above only. */
async function update(tx: Tx, table: string, columns: Record<string, string>, id: string, patch: object) {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = columns[field];
    if (!column) throw new Error(`unknown field ${field}`);
    values.push(JSON_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length) await tx.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1`, values);
}

export function pgStore(tx: Tx): FlowStore {
  return {
    async workflow(key, opts) {
      const [r] = await rows(tx, `SELECT * FROM workflows WHERE key = $1${opts?.lock ? " FOR UPDATE" : ""}`, [key]);
      return r ? workflowFrom(r) : undefined;
    },
    async createWorkflow(w) {
      await tx.query("INSERT INTO workflows (id, key, name) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING", [
        w.id,
        w.key,
        w.name,
      ]);
      const [r] = await rows(tx, "SELECT * FROM workflows WHERE key = $1 FOR UPDATE", [w.key]);
      return workflowFrom(r!);
    },
    async setDraft(workflowId, draft) {
      await tx.query(
        "UPDATE workflows SET draft_definition = $2, draft_updated_at = $3, draft_updated_by = $4 WHERE id = $1",
        [workflowId, draft ? JSON.stringify(draft.definition) : null, draft?.at ?? null, draft?.by ?? null],
      );
    },
    async currentVersion(workflowId) {
      const [r] = await rows(
        tx,
        "SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY version DESC LIMIT 1",
        [workflowId],
      );
      return r ? versionFrom(r) : undefined;
    },
    async insertVersion(v) {
      await tx.query(
        "INSERT INTO workflow_versions (id, workflow_id, version, definition, published_at) VALUES ($1, $2, $3, $4, $5)",
        [v.id, v.workflowId, v.version, JSON.stringify(v.definition), v.publishedAt],
      );
    },
    async triggeredBy(eventType) {
      const found = await rows(
        tx,
        `SELECT w.id AS w_id, w.key AS w_key, w.name AS w_name, w.status AS w_status, v.*
           FROM workflows w
           JOIN LATERAL (SELECT * FROM workflow_versions WHERE workflow_id = w.id ORDER BY version DESC LIMIT 1) v ON true
          WHERE w.status = 'active' AND v.definition -> 'trigger' ->> 'event' = $1
          ORDER BY w.key`,
        [eventType],
      );
      return found.map((r) => ({
        workflow: workflowFrom({ id: r.w_id, key: r.w_key, name: r.w_name, status: r.w_status }),
        version: versionFrom(r),
      }));
    },
    async createRun(run) {
      const [r] = await rows(
        tx,
        `INSERT INTO workflow_runs (id, workflow_id, version_id, draft_definition, test, dry_run, trigger_event_id,
           trigger, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (trigger_event_id) DO NOTHING RETURNING *`,
        [
          run.id,
          run.workflowId,
          run.versionId,
          run.draftDefinition === null ? null : JSON.stringify(run.draftDefinition),
          run.test,
          run.dryRun,
          run.triggerEventId,
          JSON.stringify(run.trigger),
          run.status,
          run.startedAt,
        ],
      );
      return r ? runFrom(r) : null;
    },
    async lockRun(id) {
      const [r] = await rows(tx, "SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE", [id]);
      return r ? runFrom(r) : undefined;
    },
    updateRun: (id, patch) => update(tx, "workflow_runs", RUN_COLUMNS, id, patch),
    async version(id) {
      const [r] = await rows(tx, "SELECT * FROM workflow_versions WHERE id = $1", [id]);
      return r ? versionFrom(r) : undefined;
    },
    async workflowOf(versionId) {
      const [r] = await rows(
        tx,
        "SELECT w.* FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.id WHERE v.id = $1",
        [versionId],
      );
      return r ? workflowFrom(r) : undefined;
    },
    async steps(runId) {
      return (await rows(tx, "SELECT * FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq", [runId])).map(stepFrom);
    },
    async insertStep(s) {
      await tx.query(
        `INSERT INTO workflow_run_steps (id, run_id, step_key, status, request_event_id, outcome_event_id, input, output,
           attempts, started_at, ended_at, timeout_at, error_code, error_message, auto_retries)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          s.id,
          s.runId,
          s.stepKey,
          s.status,
          s.requestEventId,
          s.outcomeEventId,
          s.input === null ? null : JSON.stringify(s.input),
          s.output === null ? null : JSON.stringify(s.output),
          s.attempts,
          s.startedAt,
          s.endedAt,
          s.timeoutAt,
          s.errorCode,
          s.errorMessage,
          s.autoRetries,
        ],
      );
    },
    updateStep: (id, patch) => update(tx, "workflow_run_steps", STEP_COLUMNS, id, patch),
    async insertApproval(a) {
      await tx.query(
        `INSERT INTO approvals (id, run_id, step_id, status, assignee_role, deadline, decided_by, decided_at, comment,
           edited, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          a.id,
          a.runId,
          a.stepId,
          a.status,
          a.assigneeRole,
          a.deadline,
          a.decidedBy,
          a.decidedAt,
          a.comment,
          a.edited === null ? null : JSON.stringify(a.edited),
          a.createdAt,
        ],
      );
    },
    async approval(id) {
      const [r] = await rows(tx, "SELECT * FROM approvals WHERE id = $1", [id]);
      return r ? approvalFrom(r) : undefined;
    },
    async approvalsOf(runId) {
      return (await rows(tx, "SELECT * FROM approvals WHERE run_id = $1 ORDER BY created_at, id", [runId])).map(
        approvalFrom,
      );
    },
    updateApproval: (id, patch) => update(tx, "approvals", APPROVAL_COLUMNS, id, patch),
    async claimOverdueRun(now) {
      const [r] = await rows(
        tx,
        `SELECT r.id FROM workflow_runs r
          WHERE r.status = 'waiting'
            AND (EXISTS (SELECT 1 FROM workflow_run_steps s
                          WHERE s.run_id = r.id AND s.status = 'waiting' AND s.timeout_at <= $1)
                 OR EXISTS (SELECT 1 FROM approvals a
                             WHERE a.run_id = r.id AND a.status = 'pending' AND a.deadline <= $1))
          ORDER BY r.started_at
          LIMIT 1
          FOR UPDATE OF r SKIP LOCKED`,
        [now],
      );
      return r?.id as string | undefined;
    },
    async claimDueStep(now) {
      const [r] = await rows(
        tx,
        `SELECT r.id FROM workflow_runs r
          WHERE r.status = 'running'
            AND EXISTS (SELECT 1 FROM workflow_run_steps s
                         WHERE s.run_id = r.id AND s.status IN ('pending', 'running') AND s.timeout_at <= $1)
          ORDER BY r.started_at
          LIMIT 1
          FOR UPDATE OF r SKIP LOCKED`,
        [now],
      );
      return r?.id as string | undefined;
    },
    async setWorkflowStatus(key, status) {
      const [r] = await rows(
        tx,
        `UPDATE workflows w SET status = $2 FROM (SELECT id, status FROM workflows WHERE key = $1 FOR UPDATE) old
          WHERE w.id = old.id RETURNING old.status AS previous`,
        [key, status],
      );
      return r?.previous as WorkflowStatus | undefined;
    },
  };
}
