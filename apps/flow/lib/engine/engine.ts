/**
 * The engine: every transition of a run, each inside ONE database transaction (the caller's `tx`)
 * together with the outbox row it publishes, so a step is never waiting without its request, nor a
 * request sent for a step that isn't waiting. It runs both definition versions, as a graph of nodes
 * (lib/workflow/graph.ts): a v1 definition is its steps in order.
 *
 *   start           → `startRun`, for every trigger type (an event, a person's "Run now", a webhook):
 *                     a run pinned to the workflow's current version (one per trigger event id)
 *   condition       → true: `then`; false: `else` (v1: the run ends `skipped`)
 *   action          → publish the request, the step `waiting` (request_event_id, timeout_at)
 *     done outcome  → output = its payload, the next node
 *     failed        → the run `failed` with the outcome's code and message
 *     timeout       → (the sweeper) the step `timed_out`, the run `failed` with `action_timeout`
 *   approval        → a `pending` approval (its deadline), the step and the run `waiting`; the step's
 *                     input is the draft it reviews (checked: lib/workflow/approval.ts), if it reviews one
 *     approve       → the approval `approved` (with the edits), the step `succeeded` (output = the
 *                     decision), the next node; a public repository must be acknowledged
 *     reject        → the approval `rejected`, the step `failed`, the run `rejected`
 *     deadline      → (the sweeper) the approval `expired`, the step `timed_out`, the run `failed`
 *                     with `approval_expired` (onExpire: stop)
 *   wait            → the step and the run `waiting` until timeout_at; (the sweeper) then the next node
 *   connector       → its input filled (placeholders), the step `pending`, due now; a worker claims it
 *                     (`claimConnector`: `running`, with a lease), calls it outside any transaction
 *                     (`invokeConnector`), then writes the result with the next transition in one
 *                     transaction (`completeConnector`). A retryable failure: `pending` again after
 *                     5 s, 30 s, 2 min; then `failed`. A lease that runs out (a crash) is claimed
 *                     again: at least once (lib/engine/connectors.ts).
 *   end             → the run `succeeded` (or `skipped`)
 *   retry           → a failed run's failed step again, with a new request event id (attempts + 1);
 *                     a decided approval stays decided (an expired one gets a new approval)
 *   cancel          → `cancelled`; a waiting step is `skipped`, a pending approval `cancelled`
 *
 * Test and dry runs (`test`, `dryRun`): a test run runs for real and is marked as one. A dry run sends
 * nothing: an action records the request it would publish and a connector the input it would send
 * (never a credential: those only reach a connector at call time), each with the simulated outcome
 * as its output; a wait doesn't wait. Approvals still wait for a person in both.
 *
 * Drafts: `saveDraft` (validated, the problems returned), `publishDraft` (a new immutable version)
 * and `startDraftRun` (a test run of the draft, carrying its definition).
 *
 * Each call returns the audit entries of what it did; the caller writes them once the transaction
 * has committed (lib/audit.ts), so a rolled-back transition is never reported.
 */
import { z } from "zod";
import type { AuditEntry } from "../audit";
import { applyEdits, COMMENT_MAX, Draft, type Decision } from "../workflow/approval";
import { isPausedAll, pausedAllRefusal } from "../settings";
import { evaluate } from "../workflow/conditions";
import type { RunContext } from "../workflow/context";
import {
  manifestProblems,
  parseDefinition,
  triggerOf,
  type AnyWorkflowDefinition,
  type EventsManifest,
  type Problem,
} from "../workflow/definition";
import { inputProblems, type TriggerType } from "../workflow/definition-v2";
import { graphOf, type Graph, type GraphNode } from "../workflow/graph";
import { buildRequest, isRequestType, RequestMappingError, simulatedOutcome } from "../workflow/requests";
import { MissingValueError, renderInput } from "../workflow/templates";
import {
  ConnectorError,
  connectors as defaultConnectors,
  DEFAULT_TIMEOUT_MS,
  NO_SERVICES,
  servicesFor,
  type ConnectorRegistry,
  type ConnectorServices,
} from "./connectors";
import type { ApprovalRow, FlowStore, RunRow, StepRow, Tx, WorkflowRow } from "./store";

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
  /** The connectors nodes may use: the process's registry by default. */
  connectors?: ConnectorRegistry;
  /** What a connector's context reaches the world with (lib/db.ts); none by default (unit tests). */
  services?: ConnectorServices;
  /** The app's manifest: what a draft is checked against before it is published or test-run. */
  manifest?: EventsManifest;
}

export type Refusal =
  | "not_found"
  | "not_retryable"
  | "not_cancellable"
  /** The approval was decided already, expired or cancelled, or its run doesn't wait on it. */
  | "not_pending"
  | "public_not_acknowledged"
  /** An edit of a field the step doesn't list in `editable`. */
  | "edit_not_allowed"
  | "invalid_edits"
  | "invalid_comment"
  /** startRun: the workflow is paused (a test run may still start). */
  | "not_active"
  /** startRun: the workflow's trigger is of another type. */
  | "wrong_trigger"
  /** startRun: the data doesn't fit the trigger's input. */
  | "invalid_input"
  /** startRun: this trigger event started a run already. */
  | "duplicate"
  /** startRun: Settings `paused_all` is on (only a dry run, which calls nothing, still starts). */
  | "paused_all"
  /** Drafts: there is none to publish or run. */
  | "no_draft"
  /** Drafts: the definition doesn't validate (or doesn't fit the manifest). */
  | "invalid_definition"
  /** Drafts: not a JSON object, larger than DRAFT_MAX_BYTES, or its key isn't the workflow's. */
  | "invalid_draft"
  /** saveDraft: someone saved the draft (or published it) since the one this save was made from. */
  | "stale_draft"
  /** saveDraft of a new workflow: one with its key exists already. */
  | "exists";
export type Result = { ok: true; audits: AuditEntry[] } | { ok: false; error: Refusal; audits: AuditEntry[] };
export type StartResult =
  | { ok: true; runId: string; audits: AuditEntry[] }
  | { ok: false; error: Refusal; problems?: Problem[]; audits: AuditEntry[] };

export interface StartRunOptions {
  workflowKey: string;
  /** The trigger type the caller serves: it must be the workflow's. */
  trigger: TriggerType;
  /** The trigger's data: the event payload, the form's fields, the webhook's body. */
  data: unknown;
  /** Unique per run: the event's id; a new id when absent (a manual run). */
  triggerEventId?: string;
  test?: boolean;
  /** A dry run is a test run that sends nothing. */
  dryRun?: boolean;
  /** Who started it (absent for an event). */
  actor?: string;
}

/** A connector step a worker claimed: what it calls, and what identifies this call. */
export interface ConnectorClaim {
  runId: string;
  workflowId: string;
  runStartedAt: Date;
  stepId: string;
  stepKey: string;
  /** The step's `attempts` once claimed: the result is written only while it is still this call's. */
  attempt: number;
  type: string;
  input: unknown;
  test: boolean;
  timeoutMs: number;
}
export type ConnectorOutcome =
  { ok: true; output: unknown } | { ok: false; code: string; retryable: boolean; message: string };

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
/** The waits before each retry of a connector call after a retryable failure; then the step fails. */
export const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000] as const;
/** How long past its own timeout a call's lease lasts before the sweeper takes it for crashed. */
export const LEASE_MARGIN_MS = 30_000;
/** The largest draft saved, as JSON. */
export const DRAFT_MAX_BYTES = 256 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type Engine = ReturnType<typeof createEngine>;

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date());
  const connectors = deps.connectors ?? defaultConnectors;

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

  async function finish(
    c: Call,
    run: RunRow,
    status: "succeeded" | "failed" | "skipped" | "rejected",
    errorCode: string | null,
  ) {
    await c.store.updateRun(run.id, { status, endedAt: now(), errorCode });
    c.audits.push({ action: "flow.run.finished", runId: run.id, status, ...(errorCode ? { errorCode } : {}) });
  }

  /**
   * Write a step's row: a new one the first time the step is reached, the same row again on a retry
   * (attempts + 1, unless `row` sets them).
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
      autoRetries: 0,
    };
    if (existing) {
      const { id: _id, ...patch } = row;
      await c.store.updateStep(existing.id, { ...base, attempts: existing.attempts + 1, ...patch });
      return existing.id;
    }
    const id = row.id ?? deps.newId();
    await c.store.insertStep({
      status: "running",
      ...base,
      attempts: 1,
      ...row,
      id,
      runId: run.id,
      stepKey: key,
    });
    return id;
  }

  /** Fail the step being reached and the run with `code`. */
  async function failStep(
    c: Call,
    run: RunRow,
    key: string,
    existing: StepRow | undefined,
    code: string,
    message: string,
    row: Partial<StepRow> = {},
  ) {
    await writeStep(c, run, key, existing, {
      ...row,
      status: "failed",
      endedAt: now(),
      errorCode: code,
      errorMessage: message.slice(0, MAX_ERROR_MESSAGE),
    });
    await finish(c, run, "failed", code);
  }

  const outputOf = (ctx: RunContext, key: string | null) =>
    key !== null && Object.hasOwn(ctx.steps, key) ? ctx.steps[key]!.output : undefined;

  /**
   * Reach an approval node: a `pending` approval due at now + the deadline, the step `waiting` with
   * the draft it reviews as its input, the run `waiting`. A draft that doesn't fit fails the step
   * (`invalid_draft`): nobody is asked to approve something that can't be published.
   */
  async function runApproval(c: Call, run: RunRow, node: Extract<GraphNode, { kind: "approval" }>) {
    const { ctx, rows } = await contextOf(c, run);
    const existing = rows.find((r) => r.stepKey === node.key);
    let input: unknown = null;
    if (node.reviews === "draft") {
      const draft = Draft.safeParse(outputOf(ctx, node.draft));
      if (!draft.success) {
        const where = draft.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
        return failStep(c, run, node.key, existing, "invalid_draft", `The draft doesn't fit (${where}).`);
      }
      input = draft.data;
    }
    const stepId = await writeStep(c, run, node.key, existing, { status: "waiting", input });
    const createdAt = now();
    await c.store.insertApproval({
      id: deps.newId(),
      runId: run.id,
      stepId,
      status: "pending",
      assigneeRole: node.role,
      deadline: new Date(createdAt.getTime() + node.deadlineMs),
      decidedBy: null,
      decidedAt: null,
      comment: null,
      edited: null,
      createdAt,
    });
    await c.store.updateRun(run.id, { status: "waiting", endedAt: null, errorCode: null });
  }

  /** Reach an action node: publish its request and wait; in a dry run, record it and go on. The next node to run, if any. */
  async function runAction(
    c: Call,
    run: RunRow,
    node: Extract<GraphNode, { kind: "action" }>,
  ): Promise<string | undefined> {
    const { ctx, rows } = await contextOf(c, run);
    const existing = rows.find((r) => r.stepKey === node.key);
    const stepId = existing?.id ?? deps.newId();
    if (!isRequestType(node.request)) {
      await failStep(c, run, node.key, existing, "request_mapping_failed", `no mapping for ${node.request}`, {
        id: stepId,
      });
      return undefined;
    }
    let payload: object;
    try {
      payload = buildRequest(node.request, { ...ctx, stepId, approval: outputOf(ctx, node.approval) });
    } catch (err) {
      if (!(err instanceof RequestMappingError)) throw err;
      await failStep(c, run, node.key, existing, "request_mapping_failed", err.message, { id: stepId });
      return undefined;
    }
    if (run.dryRun) {
      await writeStep(c, run, node.key, existing, {
        id: stepId,
        status: "succeeded",
        input: payload,
        output: simulatedOutcome(node.request, payload),
        endedAt: now(),
      });
      return node.next;
    }
    const event = await deps.publish(c.tx, node.request, payload, run.id);
    const startedAt = now();
    await writeStep(c, run, node.key, existing, {
      id: stepId,
      status: "waiting",
      requestEventId: event.id,
      input: payload,
      startedAt,
      timeoutAt: new Date(startedAt.getTime() + node.timeoutMs),
    });
    await c.store.updateRun(run.id, { status: "waiting", endedAt: null, errorCode: null });
    return undefined;
  }

  /** Reach a wait node: the step and the run wait until timeout_at (the sweeper resumes it); a dry run goes on. */
  async function runWait(
    c: Call,
    run: RunRow,
    node: Extract<GraphNode, { kind: "wait" }>,
  ): Promise<string | undefined> {
    const existing = (await c.store.steps(run.id)).find((r) => r.stepKey === node.key);
    const startedAt = now();
    const until = new Date(startedAt.getTime() + node.durationMs);
    if (run.dryRun) {
      await writeStep(c, run, node.key, existing, {
        status: "succeeded",
        input: { until: until.toISOString() },
        endedAt: startedAt,
      });
      return node.next;
    }
    await writeStep(c, run, node.key, existing, {
      status: "waiting",
      input: { until: until.toISOString() },
      startedAt,
      timeoutAt: until,
    });
    await c.store.updateRun(run.id, { status: "waiting", endedAt: null, errorCode: null });
    return undefined;
  }

  /**
   * Reach a connector node: fill its input's placeholders and check it, then the step `pending`, due
   * now, for a worker to call; a dry run records the input and the simulated output and goes on. A
   * missing value fails the step (`missing_value`), as does an input that doesn't fit (`invalid_input`).
   */
  async function runConnector(
    c: Call,
    run: RunRow,
    node: Extract<GraphNode, { kind: "connector" }>,
  ): Promise<string | undefined> {
    const { ctx, rows } = await contextOf(c, run);
    const existing = rows.find((r) => r.stepKey === node.key);
    const connector = connectors.get(node.type);
    const fail = async (code: string, message: string, input: unknown = null) => {
      await failStep(c, run, node.key, existing, code, message, { input, attempts: existing?.attempts ?? 0 });
      return undefined;
    };
    if (!connector) return fail("unknown_connector", `No connector ${node.type} in this process.`);
    let filled: unknown;
    try {
      filled = renderInput(connector.input, node.input, ctx);
    } catch (err) {
      if (err instanceof MissingValueError) return fail("missing_value", err.message);
      throw err;
    }
    const input = connector.input.safeParse(filled);
    if (!input.success) {
      const where = input.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      return fail("invalid_input", `The input doesn't fit the connector (${where}).`, filled);
    }
    if (run.dryRun) {
      const output = connector.output.safeParse(connector.simulate(input.data));
      if (!output.success) return fail("invalid_output", "The simulated output doesn't fit.", input.data);
      await writeStep(c, run, node.key, existing, {
        status: "succeeded",
        input: input.data,
        output: output.data,
        endedAt: now(),
        attempts: existing?.attempts ?? 0,
      });
      return node.next;
    }
    await writeStep(c, run, node.key, existing, {
      status: "pending",
      input: input.data,
      timeoutAt: now(),
      attempts: existing?.attempts ?? 0,
    });
    await c.store.updateRun(run.id, { status: "running", endedAt: null, errorCode: null });
    return undefined;
  }

  /** Run the graph from node `key` on, until a step waits (or is left to a worker) or the run ends. */
  async function runFrom(c: Call, run: RunRow, graph: Graph, key: string | null): Promise<void> {
    let at: string | null | undefined = key;
    while (at) {
      const node = graph.nodes.get(at);
      if (!node) throw new Error(`run ${run.id}: no node ${at}`);
      switch (node.kind) {
        case "action":
          at = await runAction(c, run, node);
          continue;
        case "approval":
          return runApproval(c, run, node);
        case "wait":
          at = await runWait(c, run, node);
          continue;
        case "connector":
          at = await runConnector(c, run, node);
          continue;
        case "condition": {
          const { ctx, rows } = await contextOf(c, run);
          const { passed, fields } = evaluate(node.all, ctx);
          await writeStep(
            c,
            run,
            node.key,
            rows.find((r) => r.stepKey === node.key),
            {
              status: "succeeded",
              input: fields,
              output: { passed },
              endedAt: now(),
            },
          );
          at = passed ? node.then : node.else;
          if (at === null) return finish(c, run, "skipped", null);
          continue;
        }
        case "end": {
          const existing = (await c.store.steps(run.id)).find((r) => r.stepKey === node.key);
          await writeStep(c, run, node.key, existing, { status: "succeeded", endedAt: now() });
          return finish(c, run, node.status, null);
        }
      }
    }
  }

  /** The definition the run executes: its version's, or the draft it carries (a test run). */
  async function definitionOf(c: Call, run: RunRow): Promise<AnyWorkflowDefinition> {
    if (run.draftDefinition) return run.draftDefinition;
    const version = run.versionId ? await c.store.version(run.versionId) : undefined;
    if (!version) throw new Error(`run ${run.id}: its version ${run.versionId} is gone`);
    return version.definition;
  }
  const graphOfRun = async (c: Call, run: RunRow) => graphOf(await definitionOf(c, run));

  /**
   * Start a run of `definition` (a version's, or a draft's): the trigger type must be the definition's
   * and the data fit its input; then the run, its `flow.run.started` entry and its first steps.
   */
  async function begin(
    c: Call,
    workflow: WorkflowRow,
    version: { id: string; version: number } | undefined,
    definition: AnyWorkflowDefinition,
    opts: StartRunOptions,
  ): Promise<StartResult> {
    const refuse = (error: Refusal, problems?: Problem[]): StartResult => ({
      ok: false,
      error,
      ...(problems ? { problems } : {}),
      audits: [],
    });
    const trigger = triggerOf(definition);
    if (trigger.type !== opts.trigger) return refuse("wrong_trigger");
    if (opts.dryRun !== true && (await isPausedAll(c.tx))) return refuse("paused_all");
    if (!isRecord(opts.data)) return refuse("invalid_input", [{ path: "", message: "must be an object" }]);
    if (trigger.type === "manual" || trigger.type === "webhook") {
      const problems = inputProblems(trigger.input, opts.data);
      if (problems.length)
        return refuse(
          "invalid_input",
          problems.map((message) => ({ path: "", message })),
        );
    }
    const dryRun = opts.dryRun === true;
    const triggerEventId = opts.triggerEventId ?? deps.newId();
    const test = opts.test === true || dryRun;
    const run = await c.store.createRun({
      id: deps.newId(),
      workflowId: workflow.id,
      versionId: version?.id ?? null,
      draftDefinition: version ? null : definition,
      test,
      dryRun,
      triggerEventId,
      trigger: opts.data,
      status: "running",
      startedAt: now(),
      endedAt: null,
      errorCode: null,
    });
    if (!run) return refuse("duplicate");
    c.audits.push({
      action: "flow.run.started",
      runId: run.id,
      workflow: workflow.key,
      ...(version ? { version: version.version } : {}),
      triggerEventId,
      ...(test ? { test } : {}),
      ...(dryRun ? { dryRun } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
    });
    const graph = graphOf(definition);
    await runFrom(c, run, graph, graph.start);
    return { ok: true, runId: run.id, audits: c.audits };
  }

  /** Start a run of a workflow's current version: every trigger type comes through here. */
  async function startRun(tx: Tx, opts: StartRunOptions): Promise<StartResult> {
    const c = call(tx);
    const workflow = await c.store.workflow(opts.workflowKey);
    const version = workflow ? await c.store.currentVersion(workflow.id) : undefined;
    if (!workflow || !version) return { ok: false, error: "not_found", audits: [] };
    if (workflow.status !== "active" && !(opts.test || opts.dryRun)) {
      return { ok: false, error: "not_active", audits: [] };
    }
    return begin(c, workflow, version, version.definition, opts);
  }

  /** A trigger event: one run per active workflow it triggers, unless this event already started one. */
  async function onTrigger(tx: Tx, event: InboundEvent): Promise<AuditEntry[]> {
    const data = event.data;
    if (!isRecord(data)) {
      deps.log.warn("flow.trigger.ignored", { eventId: event.id, type: event.type, reason: "data_not_an_object" });
      return [];
    }
    if (await isPausedAll(tx)) return pausedAllRefusal(deps.log, event);
    const audits: AuditEntry[] = [];
    for (const { workflow } of await deps.store(tx).triggeredBy(event.type)) {
      const r = await startRun(tx, {
        workflowKey: workflow.key,
        trigger: "event",
        data,
        triggerEventId: event.id,
      });
      if (r.ok) audits.push(...r.audits);
      else if (r.error === "duplicate")
        deps.log.info("flow.trigger.duplicate", { eventId: event.id, workflow: workflow.key });
      else deps.log.warn("flow.trigger.refused", { eventId: event.id, workflow: workflow.key, reason: r.error });
    }
    return audits;
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
    const graph = await graphOfRun(c, run);
    const node = graph.nodes.get(row.stepKey);
    if (node?.kind !== "action") return ignore("not_an_action", { runId, stepId });
    const kind = event.type === node.done ? "done" : event.type === node.failed ? "failed" : undefined;
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
      await runFrom(c, run, graph, node.next);
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

  type Decided =
    | { ok: false; error: Refusal }
    | {
        ok: true;
        run: RunRow;
        approval: ApprovalRow;
        row: StepRow;
        graph: Graph;
        node: Extract<GraphNode, { kind: "approval" }>;
      };

  /**
   * An approval that can be decided now, with its run locked: pending, before its deadline, and its
   * run and step waiting on it. Otherwise `not_pending` (`not_found` when there is no such approval).
   */
  async function decidable(c: Call, approvalId: string): Promise<Decided> {
    const seen = await c.store.approval(approvalId);
    if (!seen) return { ok: false, error: "not_found" };
    const run = await c.store.lockRun(seen.runId);
    // Read again under the run's lock: a decision that committed meanwhile is seen.
    const approval = await c.store.approval(approvalId);
    if (!run || !approval) return { ok: false, error: "not_found" };
    if (approval.status !== "pending" || run.status !== "waiting") return { ok: false, error: "not_pending" };
    if (approval.deadline && approval.deadline <= now()) return { ok: false, error: "not_pending" };
    const row = (await c.store.steps(run.id)).find((s) => s.id === approval.stepId);
    if (row?.status !== "waiting") return { ok: false, error: "not_pending" };
    const graph = await graphOfRun(c, run);
    const node = graph.nodes.get(row.stepKey);
    if (node?.kind !== "approval") return { ok: false, error: "not_pending" };
    return { ok: true, run, approval, row, graph, node };
  }

  /** The workflow's draft, parsed and checked against the manifest. */
  function checkDraft(
    value: unknown,
  ): { ok: true; definition: AnyWorkflowDefinition } | { ok: false; problems: Problem[] } {
    const parsed = parseDefinition(value, { connectors });
    if (!parsed.ok) return { ok: false, problems: parsed.issues };
    const problems = deps.manifest ? manifestProblems(parsed.definition, deps.manifest) : [];
    if (problems.length) return { ok: false, problems: problems.map((message) => ({ path: "", message })) };
    return { ok: true, definition: parsed.definition };
  }

  return {
    onTrigger,
    onOutcome,
    startRun,

    /** What is wrong with a definition (the draft's checks: validation, then the manifest); none: it publishes. */
    checkDefinition(value: unknown): Problem[] {
      const checked = checkDraft(value);
      return checked.ok ? [] : checked.problems;
    },

    /** Every subscribed event: it may start runs, and when it names a run and a step, it is an outcome. */
    async handle(tx: Tx, event: InboundEvent): Promise<AuditEntry[]> {
      const audits = await onTrigger(tx, event);
      const data = event.data as { runId?: unknown } | null;
      if (data && typeof data === "object" && "runId" in data) audits.push(...(await onOutcome(tx, event)));
      return audits;
    },

    /**
     * The sweeper's unit of work: one overdue run (locked, skipped by other instances). A wait that is
     * over resumes the run at its next node. An overdue action step `timed_out` and the run `failed`
     * with `action_timeout`; a pending approval past the deadline `expired`, the approval step
     * `timed_out` and the run `failed` with `approval_expired` (onExpire: stop). Undefined when none is due.
     */
    async sweepOne(tx: Tx): Promise<{ runId: string; audits: AuditEntry[] } | undefined> {
      const c = call(tx);
      const at = now();
      const runId = await c.store.claimOverdueRun(at);
      if (!runId) return undefined;
      const run = (await c.store.lockRun(runId))!;
      const steps = await c.store.steps(runId);
      const graph = await graphOfRun(c, run);
      const expired = (await c.store.approvalsOf(runId)).filter(
        (a) => a.status === "pending" && a.deadline !== null && a.deadline <= at,
      );
      for (const a of expired) {
        await c.store.updateApproval(a.id, { status: "expired" });
        const s = steps.find((x) => x.id === a.stepId);
        if (s?.status !== "waiting") continue;
        await c.store.updateStep(s.id, {
          status: "timed_out",
          endedAt: at,
          errorCode: "approval_expired",
          errorMessage: "Nobody decided before the approval's deadline.",
        });
      }
      const overdue = steps.filter((s) => s.status === "waiting" && s.timeoutAt !== null && s.timeoutAt <= at);
      let timedOut = false;
      for (const s of overdue) {
        const node = graph.nodes.get(s.stepKey);
        if (node?.kind === "wait" && !expired.length) {
          await c.store.updateStep(s.id, { status: "succeeded", endedAt: at, timeoutAt: null });
          await c.store.updateRun(run.id, { status: "running", errorCode: null });
          await runFrom(c, { ...run, status: "running" }, graph, node.next);
          continue;
        }
        timedOut = true;
        await c.store.updateStep(s.id, {
          status: "timed_out",
          endedAt: at,
          errorCode: "action_timeout",
          errorMessage: "No answer before the step's timeout.",
        });
      }
      if (expired.length || timedOut) {
        await finish(c, run, "failed", expired.length ? "approval_expired" : "action_timeout");
      }
      return { runId, audits: c.audits };
    },

    /**
     * Claim one due connector step (its run locked, skipped by other instances): `running`, attempts
     * + 1, with a lease of its timeout + LEASE_MARGIN_MS. A step still `running` whose lease ran out was
     * being called by a process that died: it is called again (at least once), counted as a retry.
     * Undefined when none is due; `claim` absent when the step failed instead (no connector, or
     * interrupted too often).
     */
    async claimConnector(tx: Tx): Promise<{ claim?: ConnectorClaim; audits: AuditEntry[] } | undefined> {
      const c = call(tx);
      const at = now();
      const runId = await c.store.claimDueStep(at);
      if (!runId) return undefined;
      const run = (await c.store.lockRun(runId))!;
      const row = (await c.store.steps(runId)).find(
        (s) => (s.status === "pending" || s.status === "running") && s.timeoutAt !== null && s.timeoutAt <= at,
      );
      if (!row) return { audits: [] };
      const node = (await graphOfRun(c, run)).nodes.get(row.stepKey);
      const connector = node?.kind === "connector" ? connectors.get(node.type) : undefined;
      const fail = async (code: string, message: string) => {
        await c.store.updateStep(row.id, {
          status: "failed",
          endedAt: at,
          timeoutAt: null,
          errorCode: code,
          errorMessage: message,
        });
        await finish(c, run, "failed", code);
        return { audits: c.audits };
      };
      if (!connector) return fail("unknown_connector", `No connector ${node?.type ?? row.stepKey} in this process.`);
      let autoRetries = row.autoRetries;
      if (row.status === "running") {
        deps.log.warn("flow.connector.lease_expired", { runId, stepId: row.id, attempt: row.attempts });
        if (autoRetries >= RETRY_BACKOFF_MS.length) {
          return fail("interrupted", "The connector call was interrupted every time it was tried.");
        }
        autoRetries += 1;
      }
      const timeoutMs = connector.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const attempt = row.attempts + 1;
      await c.store.updateStep(row.id, {
        status: "running",
        attempts: attempt,
        autoRetries,
        timeoutAt: new Date(at.getTime() + timeoutMs + LEASE_MARGIN_MS),
      });
      return {
        claim: {
          runId,
          workflowId: run.workflowId,
          runStartedAt: run.startedAt,
          stepId: row.id,
          stepKey: row.stepKey,
          attempt,
          type: connector.type,
          input: row.input,
          test: run.test,
          timeoutMs,
        },
        audits: [],
      };
    },

    /**
     * Call the claimed connector, outside any transaction: its output (checked against its schema), or
     * the error. Never throws: an error that isn't a ConnectorError is a retryable `connector_error`
     * (its text isn't kept: it may hold anything), running out of time a retryable `timeout`.
     */
    async invokeConnector(claim: ConnectorClaim): Promise<ConnectorOutcome> {
      const connector = connectors.get(claim.type);
      if (!connector) {
        return { ok: false, code: "unknown_connector", retryable: false, message: `No connector ${claim.type}.` };
      }
      const input = connector.input.safeParse(claim.input);
      if (!input.success) {
        return { ok: false, code: "invalid_input", retryable: false, message: "The input doesn't fit the connector." };
      }
      const fields = { runId: claim.runId, stepId: claim.stepId, connector: claim.type, attempt: claim.attempt };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ConnectorError("timeout", true, `No answer within ${claim.timeoutMs} ms.`));
        }, claim.timeoutMs);
      });
      try {
        const output = await Promise.race([
          connector.run(
            {
              runId: claim.runId,
              workflowId: claim.workflowId,
              runStartedAt: claim.runStartedAt,
              stepId: claim.stepId,
              stepKey: claim.stepKey,
              attempt: claim.attempt,
              test: claim.test,
              signal: controller.signal,
              log: {
                info: (msg, f) => deps.log.info(msg, { ...fields, ...f }),
                warn: (msg, f) => deps.log.warn(msg, { ...fields, ...f }),
              },
              ...servicesFor(deps.services ?? NO_SERVICES, {
                connector: claim.type,
                runId: claim.runId,
                stepId: claim.stepId,
              }),
            },
            input.data,
          ),
          timedOut,
        ]);
        const parsed = connector.output.safeParse(output);
        if (!parsed.success) {
          return {
            ok: false,
            code: "invalid_output",
            retryable: false,
            message: "The connector's output doesn't fit.",
          };
        }
        return { ok: true, output: parsed.data };
      } catch (err) {
        if (err instanceof ConnectorError) {
          return { ok: false, code: err.code, retryable: err.retryable, message: err.message };
        }
        deps.log.warn("flow.connector.threw", { ...fields, error: (err as Error)?.name ?? "unknown" });
        return { ok: false, code: "connector_error", retryable: true, message: "The connector failed unexpectedly." };
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Write a call's result with the next transition, in one transaction: success → the step
     * `succeeded` and the run goes on; a retryable failure with retries left → `pending` again after
     * the next backoff; otherwise the step and the run `failed` with the error code. A result for a
     * call that is no longer the step's (cancelled, or claimed again after its lease ran out) is dropped.
     */
    async completeConnector(tx: Tx, claim: ConnectorClaim, outcome: ConnectorOutcome): Promise<AuditEntry[]> {
      const c = call(tx);
      const run = await c.store.lockRun(claim.runId);
      const row = run ? (await c.store.steps(run.id)).find((s) => s.id === claim.stepId) : undefined;
      if (!run || !row || row.status !== "running" || row.attempts !== claim.attempt || run.status !== "running") {
        deps.log.warn("flow.connector.result_dropped", {
          runId: claim.runId,
          stepId: claim.stepId,
          attempt: claim.attempt,
        });
        return [];
      }
      const at = now();
      if (outcome.ok) {
        await c.store.updateStep(row.id, {
          status: "succeeded",
          output: outcome.output,
          endedAt: at,
          timeoutAt: null,
          errorCode: null,
          errorMessage: null,
        });
        const graph = await graphOfRun(c, run);
        const node = graph.nodes.get(row.stepKey);
        if (node?.kind !== "connector") throw new Error(`run ${run.id}: ${row.stepKey} isn't a connector node`);
        await runFrom(c, run, graph, node.next);
        return c.audits;
      }
      const message = outcome.message.slice(0, MAX_ERROR_MESSAGE);
      const backoff = RETRY_BACKOFF_MS[row.autoRetries];
      if (outcome.retryable && backoff !== undefined) {
        await c.store.updateStep(row.id, {
          status: "pending",
          autoRetries: row.autoRetries + 1,
          timeoutAt: new Date(at.getTime() + backoff),
          errorCode: outcome.code,
          errorMessage: message,
        });
        return c.audits;
      }
      await c.store.updateStep(row.id, {
        status: "failed",
        endedAt: at,
        timeoutAt: null,
        errorCode: outcome.code,
        errorMessage: message,
      });
      await finish(c, run, "failed", outcome.code);
      return c.audits;
    },

    /**
     * Approve: `edits` may change the step's `editable` fields only; a draft for a public repository
     * needs `acknowledgedPublic`. The approval `approved` (who, when, the fields that changed), the step
     * `succeeded` with the decision as its output, and the run goes on (the next action publishes). An
     * approval that reviews nothing takes no edits.
     */
    async approve(
      tx: Tx,
      approvalId: string,
      decider: string,
      edits: unknown,
      acknowledgedPublic: boolean,
    ): Promise<Result> {
      const c = call(tx);
      const d = await decidable(c, approvalId);
      if (!d.ok) return { ok: false, error: d.error, audits: [] };
      const decidedAt = now();
      let decision: Decision | { approvalId: string; decidedBy: string; decidedAt: string };
      let changed: Record<string, unknown> | null = null;
      if (d.node.reviews === "draft") {
        const draft = Draft.parse(d.row.input);
        const applied = applyEdits(draft, d.node, edits);
        if (!applied.ok) return { ok: false, error: applied.error, audits: [] };
        if (draft.public && acknowledgedPublic !== true) {
          return { ok: false, error: "public_not_acknowledged", audits: [] };
        }
        changed = applied.changed;
        decision = {
          noteId: draft.noteId,
          repo: draft.repo,
          ...applied.final,
          acknowledgedPublic: draft.public,
          approvalId,
          decidedBy: decider,
          decidedAt: decidedAt.toISOString(),
        };
      } else {
        if (isRecord(edits) && Object.keys(edits).length) return { ok: false, error: "edit_not_allowed", audits: [] };
        decision = { approvalId, decidedBy: decider, decidedAt: decidedAt.toISOString() };
      }
      await c.store.updateApproval(approvalId, { status: "approved", decidedBy: decider, decidedAt, edited: changed });
      await c.store.updateStep(d.row.id, { status: "succeeded", output: decision, endedAt: decidedAt });
      await c.store.updateRun(d.run.id, { status: "running", errorCode: null });
      c.audits.push({
        action: "flow.approval.decided",
        runId: d.run.id,
        stepId: d.row.id,
        approvalId,
        decision: "approved",
        actor: decider,
      });
      await runFrom(c, { ...d.run, status: "running" }, d.graph, d.node.next);
      return { ok: true, audits: c.audits };
    },

    /** Reject, with an optional comment (≤ 1000): the approval `rejected`, the run ends `rejected`. */
    async reject(tx: Tx, approvalId: string, decider: string, comment?: string | null): Promise<Result> {
      const c = call(tx);
      const text = comment?.trim() ? comment.trim() : null;
      if (text !== null && text.length > COMMENT_MAX) return { ok: false, error: "invalid_comment", audits: [] };
      const d = await decidable(c, approvalId);
      if (!d.ok) return { ok: false, error: d.error, audits: [] };
      const decidedAt = now();
      await c.store.updateApproval(approvalId, { status: "rejected", decidedBy: decider, decidedAt, comment: text });
      await c.store.updateStep(d.row.id, { status: "failed", endedAt: decidedAt, errorCode: "rejected" });
      c.audits.push({
        action: "flow.approval.decided",
        runId: d.run.id,
        stepId: d.row.id,
        approvalId,
        decision: "rejected",
        actor: decider,
      });
      await finish(c, d.run, "rejected", null);
      return { ok: true, audits: c.audits };
    },

    /** Retry a failed run: its failed (or timed-out) step again, with a new request event id. */
    async retry(tx: Tx, runId: string, actor: string): Promise<Result> {
      const c = call(tx);
      const run = await c.store.lockRun(runId);
      if (!run) return { ok: false, error: "not_found", audits: [] };
      const failed = (await c.store.steps(run.id)).findLast((s) => s.status === "failed" || s.status === "timed_out");
      if (run.status !== "failed" || !failed) return { ok: false, error: "not_retryable", audits: [] };
      const graph = await graphOfRun(c, run);
      if (!graph.nodes.has(failed.stepKey)) return { ok: false, error: "not_retryable", audits: [] };

      await c.store.updateRun(run.id, { status: "running", endedAt: null, errorCode: null });
      c.audits.push({
        action: "flow.run.retried",
        runId: run.id,
        stepId: failed.id,
        attempt: failed.attempts + 1,
        actor,
      });
      await runFrom(c, { ...run, status: "running" }, graph, failed.stepKey);
      return { ok: true, audits: c.audits };
    },

    /** Cancel a run that hasn't succeeded or stopped: `cancelled`, a waiting step `skipped`, a pending approval `cancelled`. */
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
      for (const a of await c.store.approvalsOf(run.id)) {
        if (a.status === "pending") await c.store.updateApproval(a.id, { status: "cancelled" });
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
      const store = deps.store(tx);
      const workflow = await store.workflow(key, { lock: true });
      const previous = workflow ? await store.setWorkflowStatus(key, status) : undefined;
      if (!workflow || previous === undefined) return { ok: false, error: "not_found", audits: [] };
      if (previous === status) return { ok: true, audits: [] };
      const action = status === "paused" ? "flow.workflow.paused" : "flow.workflow.resumed";
      return { ok: true, audits: [{ action, workflow: key, workflowId: workflow.id, actor }] };
    },

    /**
     * Save a workflow's draft (a new workflow when there is none with its key, named `name`): stored as
     * it is, valid or not, with the problems found, each with its node's key. Refused when it isn't a
     * JSON object of at most DRAFT_MAX_BYTES whose `key` is `workflowKey`.
     *
     * `expect` (the builder): `"new"` refuses (`exists`) when the workflow exists already; a
     * `draftUpdatedAt` refuses (`stale_draft`) unless the draft saved now is the one the editor last saw
     * (null: none, as after a publish), so a save never overwrites someone else's; `not_found` when
     * there is no such workflow. Without it, the draft is saved whatever is there.
     */
    async saveDraft(
      tx: Tx,
      opts: {
        workflowKey: string;
        name?: string;
        definition: unknown;
        actor: string;
        expect?: "new" | { draftUpdatedAt: Date | null };
      },
    ): Promise<
      | { ok: true; problems: Problem[]; workflowId: string; draftUpdatedAt: Date; audits: AuditEntry[] }
      | { ok: false; error: Refusal; audits: AuditEntry[] }
    > {
      const def = opts.definition;
      if (!isRecord(def) || def.key !== opts.workflowKey || JSON.stringify(def).length > DRAFT_MAX_BYTES) {
        return { ok: false, error: "invalid_draft", audits: [] };
      }
      const c = call(tx);
      const expect = opts.expect;
      let workflow = await c.store.workflow(opts.workflowKey, { lock: true });
      if (workflow && expect === "new") return { ok: false, error: "exists", audits: [] };
      if (!workflow && expect !== undefined && expect !== "new") return { ok: false, error: "not_found", audits: [] };
      if (workflow && expect !== undefined && expect !== "new") {
        if ((workflow.draftUpdatedAt?.getTime() ?? null) !== (expect.draftUpdatedAt?.getTime() ?? null))
          return { ok: false, error: "stale_draft", audits: [] };
      }
      if (!workflow) {
        const id = deps.newId();
        workflow = await c.store.createWorkflow({
          id,
          key: opts.workflowKey,
          name: opts.name?.trim().slice(0, 200) || opts.workflowKey,
        });
        // Another transaction created it first (createWorkflow keeps the existing one).
        if (expect === "new" && workflow.id !== id) return { ok: false, error: "exists", audits: [] };
      }
      const at = now();
      await c.store.setDraft(workflow.id, { definition: def, at, by: opts.actor });
      const checked = checkDraft(def);
      return {
        ok: true,
        problems: checked.ok ? [] : checked.problems,
        workflowId: workflow.id,
        draftUpdatedAt: at,
        audits: [{ action: "flow.workflow.draft_saved", workflow: workflow.key, actor: opts.actor }],
      };
    },

    /**
     * Publish a workflow's draft as its next version (immutable) and clear the draft; runs start on it from now.
     * `check`: more problems that refuse it (the builder's: credentials, allow-lists), asked once the
     * workflow is locked, so they are about the draft that would be published.
     */
    async publishDraft(
      tx: Tx,
      opts: { workflowKey: string; actor: string; check?: (draft: unknown) => Promise<Problem[]> },
    ): Promise<
      | { ok: true; version: number; audits: AuditEntry[] }
      | { ok: false; error: Refusal; problems?: Problem[]; audits: AuditEntry[] }
    > {
      const c = call(tx);
      const workflow = await c.store.workflow(opts.workflowKey, { lock: true });
      if (!workflow) return { ok: false, error: "not_found", audits: [] };
      if (workflow.draftDefinition === null) return { ok: false, error: "no_draft", audits: [] };
      const checked = checkDraft(workflow.draftDefinition);
      const more = opts.check ? await opts.check(workflow.draftDefinition) : [];
      if (!checked.ok || more.length)
        return {
          ok: false,
          error: "invalid_definition",
          problems: [...(checked.ok ? [] : checked.problems), ...more],
          audits: [],
        };
      const version = ((await c.store.currentVersion(workflow.id))?.version ?? 0) + 1;
      await c.store.insertVersion({
        id: deps.newId(),
        workflowId: workflow.id,
        version,
        definition: checked.definition,
        publishedAt: now(),
      });
      await c.store.setDraft(workflow.id, null);
      return {
        ok: true,
        version,
        audits: [
          {
            action: "flow.workflow.published",
            workflow: workflow.key,
            workflowId: workflow.id,
            version,
            actor: opts.actor,
          },
        ],
      };
    },

    /** A test run (dry with `dryRun`) of a workflow's draft, with `data` as its trigger's data; paused or not. */
    async startDraftRun(
      tx: Tx,
      opts: { workflowKey: string; data: unknown; dryRun: boolean; actor: string },
    ): Promise<StartResult> {
      const c = call(tx);
      const workflow = await c.store.workflow(opts.workflowKey);
      if (!workflow) return { ok: false, error: "not_found", audits: [] };
      if (workflow.draftDefinition === null) return { ok: false, error: "no_draft", audits: [] };
      const checked = checkDraft(workflow.draftDefinition);
      if (!checked.ok) return { ok: false, error: "invalid_definition", problems: checked.problems, audits: [] };
      return begin(c, workflow, undefined, checked.definition, {
        workflowKey: workflow.key,
        trigger: triggerOf(checked.definition).type,
        data: opts.data,
        test: true,
        dryRun: opts.dryRun,
        actor: opts.actor,
      });
    },
  };
}
