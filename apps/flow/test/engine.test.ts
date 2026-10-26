/**
 * The engine's transitions over an in-memory store (test/memory-store.ts), with the real publisher,
 * so every request is checked against its JSON Schema: a trigger starts a run on the current version,
 * conditions skip or go on, an action waits with its request in the outbox, outcomes move it on or
 * fail it (late and duplicate ones are ignored), the sweeper times it out, retry sends a new request,
 * cancel stops it, and a paused workflow starts nothing.
 */
import { ulid } from "@asafarim/app-sdk/events";
import { beforeEach, describe, expect, it } from "vitest";
import { createEngine, type InboundEvent } from "../lib/engine/engine";
import { publisher } from "../lib/events";
import type { WorkflowDefinition } from "../lib/workflow/definition";
import { DOCS_NOTE_TO_ISSUE } from "../lib/workflow/seed";
import { memoryDb } from "./memory-store";

const NOTE = "docs.note.created.v1";
const DRAFT_READY = "docs.issue-draft.ready.v1";
const DRAFT_FAILED = "docs.issue-draft.failed.v1";
const DRAFT_REQUESTED = "flow.issue-draft.requested.v1";

const note = (over: Partial<Record<string, unknown>> = {}): InboundEvent => ({
  id: ulid(),
  type: NOTE,
  data: {
    id: "42",
    author: "dev-admin",
    docPath: "guides/getting-started.md",
    tags: ["issue"],
    hasIssue: false,
    createdAt: "2026-10-26T10:00:00.000Z",
    ...over,
  },
});

function setup(definition: WorkflowDefinition = DOCS_NOTE_TO_ISSUE.definition) {
  const mem = memoryDb();
  const clock = { now: new Date("2026-10-26T10:00:00.000Z") };
  const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    info: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
  };
  const engine = createEngine({
    store: () => mem.store,
    publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
    newId: () => ulid(),
    now: () => clock.now,
    log,
  });
  const { workflow, version } = mem.publish(definition);
  const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  const onlyRun = () => {
    expect(mem.runs.size).toBe(1);
    return [...mem.runs.values()][0]!;
  };
  const step = (key: string) => mem.steps.find((s) => s.stepKey === key)!;
  const outcome = (type: string, data: Record<string, unknown>): InboundEvent => ({ id: ulid(), type, data });
  return { mem, engine, clock, logs, workflow, version, advance, onlyRun, step, outcome };
}

/** A run of the slice-1 workflow that waits on its draft step. */
async function waitingOnDraft() {
  const t = setup();
  await t.engine.handle(t.mem.tx, note());
  return { ...t, run: t.onlyRun(), draft: t.step("draft") };
}

describe("a trigger event", () => {
  it("with #issue: a run on the current version, the condition passes, the draft step waits with its request in the outbox", async () => {
    const t = setup();
    const event = note();
    const audits = await t.engine.handle(t.mem.tx, event);

    const run = t.onlyRun();
    expect(run).toMatchObject({
      versionId: t.version.id,
      triggerEventId: event.id,
      status: "waiting",
      errorCode: null,
    });
    expect(t.step("only-tagged")).toMatchObject({
      status: "succeeded",
      input: { "trigger.tags": ["issue"], "trigger.hasIssue": false },
      output: { passed: true },
    });
    const draft = t.step("draft");
    expect(draft).toMatchObject({ status: "waiting", attempts: 1 });
    expect(draft.timeoutAt).toEqual(new Date("2026-10-26T10:05:00.000Z"));

    expect(t.mem.outbox).toHaveLength(1);
    const [row] = t.mem.outbox;
    expect(row!.type).toBe(DRAFT_REQUESTED);
    expect(draft.requestEventId).toBe(row!.id);
    expect(row!.envelope.data).toEqual({ runId: run.id, stepId: draft.id, noteId: "42", onBehalfOf: "dev-admin" });
    expect(draft.input).toEqual(row!.envelope.data);
    expect(row!.envelope).toMatchObject({ source: "asafarim://flow", subject: run.id });

    expect(audits).toEqual([
      {
        action: "flow.run.started",
        runId: run.id,
        workflow: "docs-note-to-issue",
        version: 1,
        triggerEventId: event.id,
      },
    ]);
  });

  it("without #issue: the run ends skipped, nothing is published", async () => {
    const t = setup();
    const audits = await t.engine.handle(t.mem.tx, note({ tags: ["idea"] }));
    const run = t.onlyRun();
    expect(run).toMatchObject({ status: "skipped", endedAt: t.clock.now });
    expect(t.step("only-tagged").output).toEqual({ passed: false });
    expect(t.mem.steps).toHaveLength(1);
    expect(t.mem.outbox).toHaveLength(0);
    expect(audits.map((a) => a.action)).toEqual(["flow.run.started", "flow.run.finished"]);
    expect(audits[1]).toEqual({ action: "flow.run.finished", runId: run.id, status: "skipped" });
  });

  it("a note that already has an issue is skipped too", async () => {
    const t = setup();
    await t.engine.handle(t.mem.tx, note({ hasIssue: true }));
    expect(t.onlyRun().status).toBe("skipped");
  });

  it("the same event twice starts one run (trigger_event_id, behind the inbox)", async () => {
    const t = setup();
    const event = note();
    await t.engine.handle(t.mem.tx, event);
    expect(await t.engine.handle(t.mem.tx, event)).toEqual([]);
    expect(t.mem.runs.size).toBe(1);
    expect(t.mem.outbox).toHaveLength(1);
    expect(t.logs.some((l) => l.msg === "flow.trigger.duplicate")).toBe(true);
  });

  it("a paused workflow starts nothing", async () => {
    const t = setup();
    await t.engine.setWorkflowStatus(t.mem.tx, "docs-note-to-issue", "paused", "dev-admin");
    await t.engine.handle(t.mem.tx, note());
    expect(t.mem.runs.size).toBe(0);
  });

  it("a new run is pinned to the newest version", async () => {
    const t = setup();
    const v2 = t.mem.publish({ ...DOCS_NOTE_TO_ISSUE.definition });
    await t.engine.handle(t.mem.tx, note());
    expect(t.onlyRun().versionId).toBe(v2.version.id);
  });

  it("an event no workflow is triggered by starts nothing", async () => {
    const t = setup();
    await t.engine.handle(t.mem.tx, { id: ulid(), type: "notes.note.created.v1", data: { id: "1" } });
    expect(t.mem.runs.size).toBe(0);
  });
});

describe("an action's outcome", () => {
  it("done: output = its payload, the run moves to the approval step and waits there (approval_not_implemented)", async () => {
    const t = await waitingOnDraft();
    const ready = t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, title: "Fix the guide", body: "…" });
    await t.engine.handle(t.mem.tx, ready);

    expect(t.step("draft")).toMatchObject({
      status: "succeeded",
      outcomeEventId: ready.id,
      output: ready.data,
      endedAt: t.clock.now,
      timeoutAt: null,
    });
    expect(t.step("review")).toMatchObject({ status: "waiting", errorCode: "approval_not_implemented" });
    expect(t.onlyRun()).toMatchObject({ status: "waiting", errorCode: "approval_not_implemented", endedAt: null });
    expect(t.mem.outbox).toHaveLength(1);
  });

  it("failed: the run fails with the outcome's code and message", async () => {
    const t = await waitingOnDraft();
    const audits = await t.engine.handle(
      t.mem.tx,
      t.outcome(DRAFT_FAILED, {
        runId: t.run.id,
        stepId: t.draft.id,
        code: "ai_timeout",
        message: "No answer in 60 s",
      }),
    );
    expect(t.step("draft")).toMatchObject({
      status: "failed",
      errorCode: "ai_timeout",
      errorMessage: "No answer in 60 s",
    });
    expect(t.onlyRun()).toMatchObject({ status: "failed", errorCode: "ai_timeout", endedAt: t.clock.now });
    expect(audits).toEqual([
      { action: "flow.run.finished", runId: t.run.id, status: "failed", errorCode: "ai_timeout" },
    ]);
  });

  it("a failed outcome without a code fails with action_failed", async () => {
    const t = await waitingOnDraft();
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_FAILED, { runId: t.run.id, stepId: t.draft.id }));
    expect(t.onlyRun().errorCode).toBe("action_failed");
  });

  it("a duplicate or late outcome is ignored and logged", async () => {
    const t = await waitingOnDraft();
    const ready = t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, title: "One" });
    await t.engine.handle(t.mem.tx, ready);
    const before = structuredClone(t.mem.steps);
    // The same step answered again (another event id), and a failure arriving after the success.
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, title: "Two" }));
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_FAILED, { runId: t.run.id, stepId: t.draft.id, code: "x" }));
    expect(t.mem.steps).toEqual(before);
    expect(t.logs.filter((l) => l.fields?.reason === "step_not_waiting")).toHaveLength(2);
  });

  it("an outcome for an unknown run or step, of the wrong type, or for an earlier attempt is ignored", async () => {
    const t = await waitingOnDraft();
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: "nope", stepId: t.draft.id }));
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.run.id, stepId: "nope" }));
    await t.engine.handle(t.mem.tx, t.outcome("docs.issue.created.v1", { runId: t.run.id, stepId: t.draft.id }));
    await t.engine.handle(
      t.mem.tx,
      t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, requestId: "an-earlier-request" }),
    );
    expect(t.step("draft").status).toBe("waiting");
    expect(t.logs.map((l) => l.fields?.reason).filter(Boolean)).toEqual([
      "unknown_run",
      "unknown_step",
      "unexpected_type",
      "stale_request",
    ]);
  });
});

describe("the timeout sweeper", () => {
  it("leaves a step alone before its timeout, then times it out: the run fails with action_timeout", async () => {
    const t = await waitingOnDraft();
    t.advance(4 * 60_000);
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined();
    t.advance(60_000);
    const swept = await t.engine.sweepOne(t.mem.tx);
    expect(swept?.runId).toBe(t.run.id);
    expect(t.step("draft")).toMatchObject({ status: "timed_out", errorCode: "action_timeout" });
    expect(t.onlyRun()).toMatchObject({ status: "failed", errorCode: "action_timeout", endedAt: t.clock.now });
    expect(swept?.audits).toEqual([
      { action: "flow.run.finished", runId: t.run.id, status: "failed", errorCode: "action_timeout" },
    ]);
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined();
    // An answer after the timeout is late: ignored.
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id }));
    expect(t.step("draft").status).toBe("timed_out");
  });

  it("skips a run another instance holds (SKIP LOCKED)", async () => {
    const t = await waitingOnDraft();
    t.mem.lockedElsewhere.add(t.run.id);
    t.advance(10 * 60_000);
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined();
  });

  it("doesn't touch a run waiting on an approval (no timeout_at)", async () => {
    const t = await waitingOnDraft();
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id }));
    t.advance(30 * 24 * 60 * 60_000);
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined();
  });
});

describe("retry and cancel", () => {
  it("retry of a timed-out run: the same step again with a NEW request event id, attempts + 1", async () => {
    const t = await waitingOnDraft();
    const first = t.draft.requestEventId;
    t.advance(6 * 60_000);
    await t.engine.sweepOne(t.mem.tx);

    const r = await t.engine.retry(t.mem.tx, t.run.id, "dev-admin");
    expect(r).toEqual({
      ok: true,
      audits: [{ action: "flow.run.retried", runId: t.run.id, stepId: t.draft.id, attempt: 2, actor: "dev-admin" }],
    });
    const draft = t.step("draft");
    expect(draft).toMatchObject({ id: t.draft.id, status: "waiting", attempts: 2, errorCode: null, endedAt: null });
    expect(draft.requestEventId).not.toBe(first);
    expect(draft.timeoutAt).toEqual(new Date(t.clock.now.getTime() + 5 * 60_000));
    expect(t.mem.outbox.map((o) => o.id)).toEqual([first, draft.requestEventId]);
    expect(t.mem.outbox[1]!.envelope.data).toMatchObject({ runId: t.run.id, stepId: t.draft.id });
    expect(t.onlyRun()).toMatchObject({ status: "waiting", errorCode: null, endedAt: null });

    // The first attempt's answer, echoing its request id, is stale; the new one's moves the run on.
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, requestId: first }));
    expect(t.step("draft").status).toBe("waiting");
    await t.engine.handle(
      t.mem.tx,
      t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, requestId: draft.requestEventId }),
    );
    expect(t.step("draft").status).toBe("succeeded");
  });

  it("retry of a run that failed on its outcome works the same way", async () => {
    const t = await waitingOnDraft();
    await t.engine.handle(
      t.mem.tx,
      t.outcome(DRAFT_FAILED, { runId: t.run.id, stepId: t.draft.id, code: "ai_timeout" }),
    );
    expect((await t.engine.retry(t.mem.tx, t.run.id, "dev-admin")).ok).toBe(true);
    expect(t.step("draft")).toMatchObject({ status: "waiting", attempts: 2, errorCode: null, errorMessage: null });
  });

  it("only a failed run can be retried", async () => {
    const t = await waitingOnDraft();
    expect(await t.engine.retry(t.mem.tx, t.run.id, "dev-admin")).toEqual({
      ok: false,
      error: "not_retryable",
      audits: [],
    });
    expect(await t.engine.retry(t.mem.tx, "nope", "dev-admin")).toMatchObject({ ok: false, error: "not_found" });
    expect(t.mem.outbox).toHaveLength(1);
  });

  it("cancel: the run is cancelled, its waiting step skipped, and a later answer is ignored", async () => {
    const t = await waitingOnDraft();
    const r = await t.engine.cancel(t.mem.tx, t.run.id, "dev-admin");
    expect(r).toEqual({ ok: true, audits: [{ action: "flow.run.cancelled", runId: t.run.id, actor: "dev-admin" }] });
    expect(t.onlyRun()).toMatchObject({ status: "cancelled", endedAt: t.clock.now });
    expect(t.step("draft")).toMatchObject({ status: "skipped", errorCode: "cancelled", timeoutAt: null });
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id }));
    expect(t.step("draft").status).toBe("skipped");
    expect(await t.engine.cancel(t.mem.tx, t.run.id, "dev-admin")).toMatchObject({
      ok: false,
      error: "not_cancellable",
    });
  });
});

describe("other step types and edge cases", () => {
  it("a workflow that reaches its end step succeeds", async () => {
    const t = setup({
      key: "short",
      trigger: { event: NOTE },
      steps: [
        { key: "check", type: "condition", all: [{ field: "trigger.id", op: "notEquals", value: "0" }] },
        { key: "end", type: "end" },
      ],
    });
    const audits = await t.engine.handle(t.mem.tx, note());
    expect(t.onlyRun()).toMatchObject({ status: "succeeded", endedAt: t.clock.now });
    expect(t.step("end").status).toBe("succeeded");
    expect(audits.at(-1)).toMatchObject({ action: "flow.run.finished", status: "succeeded" });
  });

  it("a condition reads an earlier step's output", async () => {
    const t = setup({
      key: "after-draft",
      trigger: { event: NOTE },
      steps: [
        {
          key: "draft",
          type: "action",
          request: DRAFT_REQUESTED,
          done: DRAFT_READY,
          failed: DRAFT_FAILED,
          timeout: "PT1M",
        },
        {
          key: "labelled",
          type: "condition",
          all: [{ field: "steps.draft.output.labels", op: "contains", value: "bug" }],
        },
        { key: "end", type: "end" },
      ],
    });
    await t.engine.handle(t.mem.tx, note());
    const run = t.onlyRun();
    await t.engine.handle(
      t.mem.tx,
      t.outcome(DRAFT_READY, { runId: run.id, stepId: t.step("draft").id, labels: ["docs"] }),
    );
    expect(t.onlyRun().status).toBe("skipped");
  });

  it("a request the run lacks data for fails its step with request_mapping_failed, publishing nothing", async () => {
    const t = setup();
    await t.engine.handle(t.mem.tx, { id: ulid(), type: NOTE, data: { tags: ["issue"], hasIssue: false } });
    expect(t.step("draft")).toMatchObject({ status: "failed", errorCode: "request_mapping_failed" });
    expect(t.onlyRun()).toMatchObject({ status: "failed", errorCode: "request_mapping_failed" });
    expect(t.mem.outbox).toHaveLength(0);
  });
});

describe("pause and resume", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("are audited when they change something, and not when they don't", async () => {
    expect(await t.engine.setWorkflowStatus(t.mem.tx, "docs-note-to-issue", "paused", "dev-admin")).toEqual({
      ok: true,
      audits: [{ action: "flow.workflow.paused", workflow: "docs-note-to-issue", actor: "dev-admin" }],
    });
    expect((await t.engine.setWorkflowStatus(t.mem.tx, "docs-note-to-issue", "paused", "dev-admin")).audits).toEqual(
      [],
    );
    expect(await t.engine.setWorkflowStatus(t.mem.tx, "docs-note-to-issue", "active", "dev-admin")).toEqual({
      ok: true,
      audits: [{ action: "flow.workflow.resumed", workflow: "docs-note-to-issue", actor: "dev-admin" }],
    });
    expect(await t.engine.setWorkflowStatus(t.mem.tx, "nope", "paused", "dev-admin")).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});
