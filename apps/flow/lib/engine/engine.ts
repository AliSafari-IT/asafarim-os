/**
 * The engine: every transition of a run, each inside ONE database transaction (the caller's `tx`)
 * together with the outbox row it publishes, so a step is never waiting without its request, nor a
 * request sent for a step that isn't waiting.
 *
 *   trigger event   → a run pinned to the workflow's current version (one per trigger event id)
 *   condition       → true: the next step; false: the run ends `skipped`
 *   action          → publish the request, the step `waiting` (request_event_id, timeout_at)
 *     done outcome  → output = its payload, the next step
 *     failed        → the run `failed` with the outcome's code and message
 *     timeout       → (the sweeper) the step `timed_out`, the run `failed` with `action_timeout`
 *   approval        → the step and the run `waiting`, `approval_not_implemented` (PR 4 replaces it)
 *   end             → the run `succeeded`
 *   retry           → a failed run's failed step again, with a new request event id (attempts + 1)
 *   cancel          → `cancelled`; a waiting step is `skipped`
 *
 * Each call returns the audit entries of what it did; the caller writes them once the transaction
 * has committed (lib/audit.ts), so a rolled-back transition is never reported.
 */
import { z } from "zod";
import type { AuditEntry } from "../audit";
import { evaluate } from "../workflow/conditions";
import type { RunContext } from "../workflow/context";
import { msOf, type ActionStep, type Step, type WorkflowDefinition } from "../workflow/definition";
import { buildRequest, isRequestType, RequestMappingError } from "../workflow/requests";
import type { FlowStore, RunRow, StepRow, Tx, VersionRow } from "./store";

/** The part of a CloudEvents envelope the engine reads. */
export interface InboundEvent {
  id: string;
  type: string;
  data: unknown;
}

export interface EngineLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface EngineDeps {
  store: (tx: Tx) => FlowStore;
  /** Validate and write ONE outbox row with `tx`; the event id. */
  publish: (tx: Tx, type: string, data: object, subject: string) => Promise<{ id: string }>;
  newId: () => string;
  now?: () => Date;
  log: EngineLogger;
}

export type Refusal = "not_found" | "not_retryable" | "not_cancellable";
export type Result = { ok: true; audits: AuditEntry[] } | { ok: false; error: Refusal; audits: AuditEntry[] };

/** What an outcome event must carry; anything else in it is the step's output. */
const Outcome = z.object({
  runId: z.string().min(1),
  stepId: z.string().min(1),
  /** When the acting app echoes it: an outcome for an earlier attempt's request is ignored. */
  requestId: z.string().min(1).optional(),
  code: z.string().min(1).max(100).optional(),
  message: z.string().optional(),
});

const MAX_ERROR_MESSAGE = 1000;

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date());

  /** One transition's state: the transaction, its store and the audit entries it collects. */
  interface Call {
    tx: Tx;
    store: FlowStore;
    audits: AuditEntry[];
  }
  const call = (tx: Tx): Call => ({ tx, store: deps.store(tx), audits: [] });

  async function contextOf(c: Call, run: RunRow): Promise<{ ctx: RunContext; rows: StepRow[] }> {
    const rows = await c.store.steps(run.id);
    const steps: RunContext["steps"] = {};
    for (const r of rows) if (r.status === "succeeded") steps[r.stepKey] = { output: r.output };
    return { ctx: { runId: run.id, trigger: run.trigger, steps }, rows };
  }

  async function finish(c: Call, run: RunRow, status: "succeeded" | "failed" | "skipped", errorCode: string | null) {
    await c.store.updateRun(run.id, { status, endedAt: now(), errorCode });
    c.audits.push({ action: "flow.run.finished", runId: run.id, status, ...(errorCode ? { errorCode } : {}) });
  }

  /**
   * Write a step's row: a new one the first time the step is reached, the same row again on a retry
   * (attempts + 1).
   */
  async function writeStep(c: Call, run: RunRow, key: string, existing: StepRow | undefined, row: Partial<StepRow>) {
    const base = {
      requestEventId: null,
      outcomeEventId: null,
      input: null,
      output: null,
      startedAt: now(),
      endedAt: null,
      timeoutAt: null,
      errorCode: null,
      errorMessage: null,
    };
    if (existing) {
      const { id: _id, ...patch } = row;
      await c.store.updateStep(existing.id, { ...base, ...patch, attempts: existing.attempts + 1 });
      return existing.id;
    }
    const id = row.id ?? deps.newId();
    await c.store.insertStep({ status: "running", ...base, ...row, id, runId: run.id, stepKey: key, attempts: 1 });
    return id;
  }

  /** The latest approval step before `index` that succeeded: what an action after it acts on. */
  function approvalBefore(def: WorkflowDefinition, index: number, ctx: RunContext): unknown {
    for (let i = index - 1; i >= 0; i--) {
      const s = def.steps[i]!;
      if (s.type === "approval" && Object.hasOwn(ctx.steps, s.key)) return ctx.steps[s.key]!.output;
    }
    return undefined;
  }

  async function runAction(c: Call, run: RunRow, def: WorkflowDefinition, index: number, step: ActionStep) {
    const { ctx, rows } = await contextOf(c, run);
    const existing = rows.find((r) => r.stepKey === step.key);
    const stepId = existing?.id ?? deps.newId();
    let payload: object;
    try {
      if (!isRequestType(step.request)) throw new RequestMappingError(`no mapping for ${step.request}`);
      payload = buildRequest(step.request, { ...ctx, stepId, approval: approvalBefore(def, index, ctx) });
    } catch (err) {
      if (!(err instanceof RequestMappingError)) throw err;
      await writeStep(c, run, step.key, existing, {
        id: stepId,
        status: "failed",
        endedAt: now(),
        errorCode: "request_mapping_failed",
        errorMessage: err.message.slice(0, MAX_ERROR_MESSAGE),
      });
      await finish(c, run, "failed", "request_mapping_failed");
      return;
    }
    const event = await deps.publish(c.tx, step.request, payload, run.id);
    const startedAt = now();
    await writeStep(c, run, step.key, existing, {
      id: stepId,
      status: "waiting",
      requestEventId: event.id,
      input: payload,
      startedAt,
      timeoutAt: new Date(startedAt.getTime() + msOf(step.timeout)),
    });
    await c.store.updateRun(run.id, { status: "waiting", endedAt: null, errorCode: null });
  }

  /** Execute the definition's steps from `index` on, until one waits or the run ends. */
  async function runFrom(c: Call, run: RunRow, def: WorkflowDefinition, index: number): Promise<void> {
    for (let i = index; i < def.steps.length; i++) {
      const step: Step = def.steps[i]!;
      if (step.type === "action") return runAction(c, run, def, i, step);

      const { ctx, rows } = await contextOf(c, run);
      const existing = rows.find((r) => r.stepKey === step.key);
      if (step.type === "condition") {
        const { passed, fields } = evaluate(step.all, ctx);
        await writeStep(c, run, step.key, existing, {
          status: "succeeded",
          input: fields,
          output: { passed },
          endedAt: now(),
        });
        if (!passed) return finish(c, run, "skipped", null);
        continue;
      }
      if (step.type === "approval") {
        // PR 4 creates the approval here. Until then the run stops and says why.
        await writeStep(c, run, step.key, existing, { status: "waiting", errorCode: "approval_not_implemented" });
        await c.store.updateRun(run.id, { status: "waiting", errorCode: "approval_not_implemented" });
        return;
      }
      await writeStep(c, run, step.key, existing, { status: "succeeded", endedAt: now() });
      return finish(c, run, "succeeded", null);
    }
  }

  async function versionOf(c: Call, run: RunRow): Promise<VersionRow> {
    const version = await c.store.version(run.versionId);
    if (!version) throw new Error(`run ${run.id}: its version ${run.versionId} is gone`);
    return version;
  }

  /** A trigger event: one run per active workflow it triggers, unless this event already started one. */
  async function onTrigger(tx: Tx, event: InboundEvent): Promise<AuditEntry[]> {
    const c = call(tx);
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      deps.log.warn("flow.trigger.ignored", { eventId: event.id, type: event.type, reason: "data_not_an_object" });
      return [];
    }
    for (const { workflow, version } of await c.store.triggeredBy(event.type)) {
      const run = await c.store.createRun({
        id: deps.newId(),
        versionId: version.id,
        triggerEventId: event.id,
        trigger: data as Record<string, unknown>,
        status: "running",
        startedAt: now(),
        endedAt: null,
        errorCode: null,
      });
      if (!run) {
        deps.log.info("flow.trigger.duplicate", { eventId: event.id, workflow: workflow.key });
        continue;
      }
      c.audits.push({
        action: "flow.run.started",
        runId: run.id,
        workflow: workflow.key,
        version: version.version,
        triggerEventId: event.id,
      });
      await runFrom(c, run, version.definition, 0);
    }
    return c.audits;
  }

  /** An outcome event (`done` or `failed` of an action step). A late, duplicate or unexpected one is ignored and logged. */
  async function onOutcome(tx: Tx, event: InboundEvent): Promise<AuditEntry[]> {
    const c = call(tx);
    const parsed = Outcome.safeParse(event.data);
    const ignore = (reason: string, fields: Record<string, unknown> = {}) => {
      deps.log.warn("flow.outcome.ignored", { eventId: event.id, type: event.type, reason, ...fields });
      return c.audits;
    };
    if (!parsed.success) return ignore("invalid_outcome");
    const { runId, stepId, requestId, code, message } = parsed.data;

    const run = await c.store.lockRun(runId);
    if (!run) return ignore("unknown_run", { runId });
    const rows = await c.store.steps(run.id);
    const row = rows.find((r) => r.id === stepId);
    if (!row) return ignore("unknown_step", { runId, stepId });
    const def = (await versionOf(c, run)).definition;
    const index = def.steps.findIndex((s) => s.key === row.stepKey);
    const step = def.steps[index];
    if (step?.type !== "action") return ignore("not_an_action", { runId, stepId });
    const kind = event.type === step.done ? "done" : event.type === step.failed ? "failed" : undefined;
    if (!kind) return ignore("unexpected_type", { runId, stepId });
    if (row.status !== "waiting" || run.status !== "waiting") {
      return ignore("step_not_waiting", { runId, stepId, status: row.status });
    }
    if (requestId !== undefined && requestId !== row.requestEventId) {
      return ignore("stale_request", { runId, stepId });
    }

    if (kind === "done") {
      await c.store.updateStep(row.id, {
        status: "succeeded",
        outcomeEventId: event.id,
        output: event.data,
        endedAt: now(),
        timeoutAt: null,
      });
      await c.store.updateRun(run.id, { status: "running", errorCode: null });
      await runFrom(c, run, def, index + 1);
    } else {
      const errorCode = code ?? "action_failed";
      await c.store.updateStep(row.id, {
        status: "failed",
        outcomeEventId: event.id,
        endedAt: now(),
        timeoutAt: null,
        errorCode,
        errorMessage: message?.slice(0, MAX_ERROR_MESSAGE) ?? null,
      });
      await finish(c, run, "failed", errorCode);
    }
    return c.audits;
  }

  return {
    onTrigger,
    onOutcome,

    /** Every subscribed event: it may start runs, and when it names a run and a step, it is an outcome. */
    async handle(tx: Tx, event: InboundEvent): Promise<AuditEntry[]> {
      const audits = await onTrigger(tx, event);
      const data = event.data as { runId?: unknown } | null;
      if (data && typeof data === "object" && "runId" in data) audits.push(...(await onOutcome(tx, event)));
      return audits;
    },

    /**
     * The timeout sweeper's unit of work: one overdue run (locked, skipped by other instances), its
     * overdue step `timed_out` and the run `failed` with `action_timeout`. Undefined when none is due.
     */
    async sweepOne(tx: Tx): Promise<{ runId: string; audits: AuditEntry[] } | undefined> {
      const c = call(tx);
      const at = now();
      const runId = await c.store.claimOverdueRun(at);
      if (!runId) return undefined;
      const run = (await c.store.lockRun(runId))!;
      const overdue = (await c.store.steps(runId)).filter(
        (s) => s.status === "waiting" && s.timeoutAt !== null && s.timeoutAt <= at,
      );
      for (const s of overdue) {
        await c.store.updateStep(s.id, {
          status: "timed_out",
          endedAt: at,
          errorCode: "action_timeout",
          errorMessage: "No answer before the step's timeout.",
        });
      }
      await finish(c, run, "failed", "action_timeout");
      return { runId, audits: c.audits };
    },

    /** Retry a failed run: its failed (or timed-out) step again, with a new request event id. */
    async retry(tx: Tx, runId: string, actor: string): Promise<Result> {
      const c = call(tx);
      const run = await c.store.lockRun(runId);
      if (!run) return { ok: false, error: "not_found", audits: [] };
      const failed = (await c.store.steps(run.id)).findLast((s) => s.status === "failed" || s.status === "timed_out");
      if (run.status !== "failed" || !failed) return { ok: false, error: "not_retryable", audits: [] };
      const def = (await versionOf(c, run)).definition;
      const index = def.steps.findIndex((s) => s.key === failed.stepKey);
      if (index < 0) return { ok: false, error: "not_retryable", audits: [] };

      await c.store.updateRun(run.id, { status: "running", endedAt: null, errorCode: null });
      c.audits.push({
        action: "flow.run.retried",
        runId: run.id,
        stepId: failed.id,
        attempt: failed.attempts + 1,
        actor,
      });
      await runFrom(c, { ...run, status: "running" }, def, index);
      return { ok: true, audits: c.audits };
    },

    /** Cancel a run that hasn't succeeded or stopped: `cancelled`, a waiting step `skipped`. */
    async cancel(tx: Tx, runId: string, actor: string): Promise<Result> {
      const c = call(tx);
      const run = await c.store.lockRun(runId);
      if (!run) return { ok: false, error: "not_found", audits: [] };
      if (!["running", "waiting", "failed"].includes(run.status)) {
        return { ok: false, error: "not_cancellable", audits: [] };
      }
      for (const s of await c.store.steps(run.id)) {
        if (s.status === "waiting" || s.status === "running" || s.status === "pending") {
          await c.store.updateStep(s.id, {
            status: "skipped",
            endedAt: now(),
            timeoutAt: null,
            errorCode: "cancelled",
          });
        }
      }
      await c.store.updateRun(run.id, { status: "cancelled", endedAt: now() });
      c.audits.push({ action: "flow.run.cancelled", runId: run.id, actor });
      return { ok: true, audits: c.audits };
    },

    /** Pause or resume a workflow. A paused workflow starts no runs; runs already going carry on. */
    async setWorkflowStatus(
      tx: Tx,
      key: string,
      status: "active" | "paused",
      actor: string,
    ): Promise<{ ok: true; audits: AuditEntry[] } | { ok: false; error: "not_found"; audits: AuditEntry[] }> {
      const previous = await deps.store(tx).setWorkflowStatus(key, status);
      if (previous === undefined) return { ok: false, error: "not_found", audits: [] };
      if (previous === status) return { ok: true, audits: [] };
      const action = status === "paused" ? "flow.workflow.paused" : "flow.workflow.resumed";
      return { ok: true, audits: [{ action, workflow: key, actor }] };
    },
  };
}
