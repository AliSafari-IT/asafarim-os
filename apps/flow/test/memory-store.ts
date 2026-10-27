/**
 * An in-memory FlowStore for the engine's unit tests, and a transaction stand-in that records the
 * outbox rows the real publisher writes through it. No rollback: each test checks what one call wrote.
 * The Postgres store is covered by test/flow.integration.test.ts.
 */
import type { ApprovalRow, FlowStore, RunRow, StepRow, VersionRow, WorkflowRow } from "../lib/engine/store";
import type { WorkflowDefinition } from "../lib/workflow/definition";

export interface OutboxRow {
  id: string;
  type: string;
  envelope: { id: string; type: string; subject?: string; data: Record<string, unknown> };
}

export function memoryDb() {
  const workflows: WorkflowRow[] = [];
  const versions: VersionRow[] = [];
  const runs = new Map<string, RunRow>();
  const steps: StepRow[] = [];
  const approvals: ApprovalRow[] = [];
  const outbox: OutboxRow[] = [];
  /** Run ids locked by "another instance": claimOverdueRun skips them, as SKIP LOCKED does. */
  const lockedElsewhere = new Set<string>();

  const tx = {
    async query(text: string, values: unknown[] = []) {
      if (!text.startsWith("INSERT INTO asafarim_outbox")) throw new Error(`unexpected query: ${text}`);
      outbox.push({
        id: values[0] as string,
        type: values[1] as string,
        envelope: JSON.parse(values[2] as string) as OutboxRow["envelope"],
      });
      return { rows: [], rowCount: 1 };
    },
  };

  const store: FlowStore = {
    async triggeredBy(eventType) {
      return workflows
        .filter((w) => w.status === "active")
        .map((w) => ({
          workflow: w,
          version: versions.filter((v) => v.workflowId === w.id).sort((a, b) => b.version - a.version)[0]!,
        }))
        .filter(({ version }) => version?.definition.trigger.event === eventType);
    },
    async createRun(run) {
      if ([...runs.values()].some((r) => r.triggerEventId === run.triggerEventId)) return null;
      runs.set(run.id, { ...run });
      return { ...run };
    },
    async lockRun(id) {
      const r = runs.get(id);
      return r ? { ...r } : undefined;
    },
    async updateRun(id, patch) {
      const r = runs.get(id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
    },
    async version(id) {
      return versions.find((v) => v.id === id);
    },
    async workflowOf(versionId) {
      const v = versions.find((x) => x.id === versionId);
      return workflows.find((w) => w.id === v?.workflowId);
    },
    async steps(runId) {
      return steps.filter((s) => s.runId === runId).map((s) => ({ ...s }));
    },
    async insertStep(s) {
      if (steps.some((x) => x.runId === s.runId && x.stepKey === s.stepKey))
        throw new Error("duplicate (run_id, step_key)");
      steps.push({ ...s });
    },
    async updateStep(id, patch) {
      const s = steps.find((x) => x.id === id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
    },
    async insertApproval(a) {
      if (a.status === "pending" && approvals.some((x) => x.stepId === a.stepId && x.status === "pending"))
        throw new Error("duplicate pending approval (approvals_one_pending)");
      approvals.push({ ...a });
    },
    async approval(id) {
      const a = approvals.find((x) => x.id === id);
      return a ? { ...a } : undefined;
    },
    async approvalsOf(runId) {
      return approvals.filter((a) => a.runId === runId).map((a) => ({ ...a }));
    },
    async updateApproval(id, patch) {
      const a = approvals.find((x) => x.id === id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (a as unknown as Record<string, unknown>)[k] = v;
    },
    async claimOverdueRun(now) {
      for (const r of runs.values()) {
        if (r.status !== "waiting" || lockedElsewhere.has(r.id)) continue;
        if (steps.some((s) => s.runId === r.id && s.status === "waiting" && s.timeoutAt && s.timeoutAt <= now))
          return r.id;
        if (approvals.some((a) => a.runId === r.id && a.status === "pending" && a.deadline && a.deadline <= now))
          return r.id;
      }
      return undefined;
    },
    async setWorkflowStatus(key, status) {
      const w = workflows.find((x) => x.key === key);
      if (!w) return undefined;
      const previous = w.status;
      w.status = status;
      return previous;
    },
  };

  let n = 0;
  return {
    tx,
    store,
    runs,
    steps,
    approvals,
    outbox,
    lockedElsewhere,
    /** A workflow with one version (or a new version of an existing workflow). */
    publish(definition: WorkflowDefinition, status: WorkflowRow["status"] = "active") {
      let w = workflows.find((x) => x.key === definition.key);
      if (!w) {
        w = { id: `wf-${++n}`, key: definition.key, name: definition.key, status };
        workflows.push(w);
      }
      const version = versions.filter((v) => v.workflowId === w.id).length + 1;
      const v: VersionRow = { id: `v-${++n}`, workflowId: w.id, version, definition, publishedAt: new Date(0) };
      versions.push(v);
      return { workflow: w, version: v };
    },
  };
}
