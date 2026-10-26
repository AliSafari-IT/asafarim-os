/** The engine's store on Flow's own Postgres database (tables: lib/migrations.ts). */
import { parseDefinition } from "../workflow/definition";
import type {
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

export function versionFrom(r: Row): VersionRow {
  const parsed = parseDefinition(r.definition);
  if (!parsed.ok) throw new Error(`workflow version ${String(r.id)} has an invalid definition: ${parsed.problems[0]}`);
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    version: r.version as number,
    definition: parsed.definition,
    publishedAt: r.published_at as Date,
  };
}

export function runFrom(r: Row): RunRow {
  return {
    id: r.id as string,
    versionId: r.version_id as string,
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
    startedAt: date(r.started_at),
    endedAt: date(r.ended_at),
    timeoutAt: date(r.timeout_at),
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
  };
}

const workflowFrom = (r: Row): WorkflowRow => ({
  id: r.id as string,
  key: r.key as string,
  name: r.name as string,
  status: r.status as WorkflowStatus,
});

const RUN_COLUMNS: Record<keyof RunPatch, string> = { status: "status", endedAt: "ended_at", errorCode: "error_code" };
const STEP_COLUMNS: Record<keyof StepPatch, string> = {
  status: "status",
  requestEventId: "request_event_id",
  outcomeEventId: "outcome_event_id",
  input: "input",
  output: "output",
  attempts: "attempts",
  startedAt: "started_at",
  endedAt: "ended_at",
  timeoutAt: "timeout_at",
  errorCode: "error_code",
  errorMessage: "error_message",
};
const JSON_COLUMNS = new Set(["input", "output"]);

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
        `INSERT INTO workflow_runs (id, version_id, trigger_event_id, trigger, status, started_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (trigger_event_id) DO NOTHING RETURNING *`,
        [run.id, run.versionId, run.triggerEventId, JSON.stringify(run.trigger), run.status, run.startedAt],
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
           attempts, started_at, ended_at, timeout_at, error_code, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
        ],
      );
    },
    updateStep: (id, patch) => update(tx, "workflow_run_steps", STEP_COLUMNS, id, patch),
    async claimOverdueRun(now) {
      const [r] = await rows(
        tx,
        `SELECT r.id FROM workflow_runs r
          WHERE r.status = 'waiting'
            AND EXISTS (SELECT 1 FROM workflow_run_steps s
                         WHERE s.run_id = r.id AND s.status = 'waiting' AND s.timeout_at <= $1)
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
