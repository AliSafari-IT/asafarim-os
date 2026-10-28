/**
 * The engine's transitions over an in-memory store (test/memory-store.ts), with the real publisher,
 * so every request is checked against its JSON Schema: a trigger starts a run on the current version,
 * conditions skip or go on, an action waits with its request in the outbox, outcomes move it on or
 * fail it (late and duplicate ones are ignored), the sweeper times it out, retry sends a new request,
 * cancel stops it, and a paused workflow starts nothing. The approval step: reached with the draft,
 * approved (with or without edits, a public repository acknowledged), rejected, decided twice,
 * expired, cancelled, and retried after it was approved.
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
const ISSUE_APPROVED = "flow.issue.approved.v1";
const ISSUE_CREATED = "docs.issue.created.v1";
const ISSUE_FAILED = "docs.issue.failed.v1";
const DAY = 24 * 60 * 60_000;

/** `docs.issue-draft.ready.v1` minus runId, stepId and requestId: what the approver reviews. */
const DRAFT = {
  noteId: "42",
  docPath: "guides/getting-started.md",
  repo: "AliSafari-IT/asafarim-docs",
  public: false,
  title: "Fix the getting-started guide",
  body: "## Context\n\nThe install step is out of date.",
  labels: ["docs"],
};

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
  it("done: output = its payload, the run moves to the approval step and waits there", async () => {
    const t = await waitingOnDraft();
    const ready = t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, ...DRAFT });
    await t.engine.handle(t.mem.tx, ready);

    expect(t.step("draft")).toMatchObject({
      status: "succeeded",
      outcomeEventId: ready.id,
      output: ready.data,
      endedAt: t.clock.now,
      timeoutAt: null,
    });
    expect(t.step("review")).toMatchObject({ status: "waiting", errorCode: null });
    expect(t.onlyRun()).toMatchObject({ status: "waiting", errorCode: null, endedAt: null });
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

  it("doesn't touch a run waiting on an approval before its deadline", async () => {
    const t = await waitingOnDraft();
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, ...DRAFT }));
    t.advance(7 * DAY - 1);
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

/** A run of the slice-1 workflow that waits on its review step, with `draft` as Docs' answer. */
async function waitingOnReview(draft: Record<string, unknown> = DRAFT) {
  const t = await waitingOnDraft();
  await t.engine.handle(
    t.mem.tx,
    t.outcome(DRAFT_READY, { runId: t.run.id, stepId: t.draft.id, requestId: t.draft.requestEventId, ...draft }),
  );
  const approval = t.mem.approvals.at(-1)!;
  return { ...t, review: t.step("review"), approval };
}

describe("the approval step", () => {
  it("reached: a pending approval due in 7 days, the step waiting with the draft as input, the run waiting", async () => {
    const t = await waitingOnReview();
    expect(t.mem.approvals).toHaveLength(1);
    expect(t.approval).toMatchObject({
      runId: t.run.id,
      stepId: t.review.id,
      status: "pending",
      assigneeRole: "flow.approver",
      deadline: new Date(t.clock.now.getTime() + 7 * DAY),
      decidedBy: null,
      decidedAt: null,
      edited: null,
    });
    // The draft without the outcome's runId, stepId and requestId.
    expect(t.review).toMatchObject({ status: "waiting", input: DRAFT, errorCode: null, timeoutAt: null });
    expect(t.onlyRun()).toMatchObject({ status: "waiting", errorCode: null });
    expect(t.mem.outbox).toHaveLength(1);
  });

  it("a draft that doesn't fit the contract fails the step with invalid_draft; nobody is asked", async () => {
    const t = await waitingOnReview({ ...DRAFT, repo: "not a repo", labels: Array(21).fill("x") });
    expect(t.mem.approvals).toHaveLength(0);
    expect(t.step("review")).toMatchObject({ status: "failed", errorCode: "invalid_draft" });
    expect(t.step("review").errorMessage).toContain("repo");
    expect(t.onlyRun()).toMatchObject({ status: "failed", errorCode: "invalid_draft" });
  });

  it("approve without edits: approved, the step's output is the decision, flow.issue.approved.v1 goes out", async () => {
    const t = await waitingOnReview();
    t.advance(60_000);
    const r = await t.engine.approve(t.mem.tx, t.approval.id, "dev-approver", {}, false);
    expect(r).toEqual({
      ok: true,
      audits: [
        {
          action: "flow.approval.decided",
          runId: t.run.id,
          stepId: t.review.id,
          approvalId: t.approval.id,
          decision: "approved",
          actor: "dev-approver",
        },
      ],
    });
    expect(t.mem.approvals[0]).toMatchObject({
      status: "approved",
      decidedBy: "dev-approver",
      decidedAt: t.clock.now,
      edited: null,
    });
    const decision = {
      noteId: "42",
      repo: DRAFT.repo,
      title: DRAFT.title,
      body: DRAFT.body,
      labels: DRAFT.labels,
      acknowledgedPublic: false,
      approvalId: t.approval.id,
      decidedBy: "dev-approver",
      decidedAt: t.clock.now.toISOString(),
    };
    expect(t.step("review")).toMatchObject({ status: "succeeded", output: decision, endedAt: t.clock.now });

    const create = t.step("create");
    expect(create).toMatchObject({ status: "waiting", attempts: 1 });
    expect(t.mem.outbox).toHaveLength(2);
    const row = t.mem.outbox[1]!;
    expect(row.type).toBe(ISSUE_APPROVED);
    expect(create.requestEventId).toBe(row.id);
    // onBehalfOf is the note's author (trigger.author), not the approver.
    expect(row.envelope.data).toEqual({
      runId: t.run.id,
      stepId: create.id,
      approvalId: t.approval.id,
      noteId: "42",
      onBehalfOf: "dev-admin",
      decidedBy: "dev-approver",
      decidedAt: t.clock.now.toISOString(),
      repo: DRAFT.repo,
      title: DRAFT.title,
      body: DRAFT.body,
      labels: DRAFT.labels,
      acknowledgedPublic: false,
    });
    expect(() => publisher.validate(ISSUE_APPROVED, row.envelope.data)).not.toThrow();
    expect(t.onlyRun()).toMatchObject({ status: "waiting", errorCode: null });

    // Docs creates the issue: the run ends succeeded.
    const audits = await t.engine.handle(
      t.mem.tx,
      t.outcome(ISSUE_CREATED, { runId: t.run.id, stepId: create.id, requestId: row.id, number: 7 }),
    );
    expect(t.onlyRun()).toMatchObject({ status: "succeeded" });
    expect(audits.at(-1)).toMatchObject({ action: "flow.run.finished", status: "succeeded" });
  });

  it("approve with edits: only the fields that changed are recorded, the request carries the final draft", async () => {
    const t = await waitingOnReview();
    const edits = { title: "Update the install step", body: DRAFT.body, labels: ["docs", "good first issue"] };
    expect((await t.engine.approve(t.mem.tx, t.approval.id, "dev-approver", edits, false)).ok).toBe(true);
    expect(t.mem.approvals[0]!.edited).toEqual({ title: edits.title, labels: edits.labels });
    expect(t.step("review").output).toMatchObject({ title: edits.title, body: DRAFT.body, labels: edits.labels });
    expect(t.mem.outbox[1]!.envelope.data).toMatchObject({ title: edits.title, labels: edits.labels });
  });

  it("edits outside the step's editable fields, or past the limits, are refused and change nothing", async () => {
    const t = await waitingOnReview();
    const refused = async (edits: unknown) => (await t.engine.approve(t.mem.tx, t.approval.id, "a", edits, true)).ok;
    for (const [edits, error] of [
      [{ repo: "someone/else" }, "edit_not_allowed"],
      [{ public: false }, "edit_not_allowed"],
      [{ title: "" }, "invalid_edits"],
      [{ title: "x".repeat(257) }, "invalid_edits"],
      [{ body: "" }, "invalid_edits"],
      [{ body: "x".repeat(60_001) }, "invalid_edits"],
      [{ labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }, "invalid_edits"],
      [{ labels: ["a", "a"] }, "invalid_edits"],
      [{ labels: ["x".repeat(51)] }, "invalid_edits"],
      [{ labels: [""] }, "invalid_edits"],
    ] as const) {
      expect(await t.engine.approve(t.mem.tx, t.approval.id, "a", edits, true)).toEqual({
        ok: false,
        error,
        audits: [],
      });
    }
    expect(await refused({ title: "ok" })).toBe(true); // still pending until then
  });

  it("a step whose editable list leaves a field out refuses an edit of it", async () => {
    const def = structuredClone(DOCS_NOTE_TO_ISSUE.definition);
    const review = def.steps.find((s) => s.type === "approval")!;
    if (review.type === "approval") review.editable = ["title"];
    const t = setup(def);
    await t.engine.handle(t.mem.tx, note());
    const draft = t.step("draft");
    await t.engine.handle(t.mem.tx, t.outcome(DRAFT_READY, { runId: t.onlyRun().id, stepId: draft.id, ...DRAFT }));
    const id = t.mem.approvals[0]!.id;
    expect(await t.engine.approve(t.mem.tx, id, "a", { body: "Changed" }, false)).toMatchObject({
      ok: false,
      error: "edit_not_allowed",
    });
    expect((await t.engine.approve(t.mem.tx, id, "a", { title: "Changed" }, false)).ok).toBe(true);
  });

  it("a public repository: refused without acknowledgedPublic, approved with it", async () => {
    const t = await waitingOnReview({ ...DRAFT, public: true });
    expect(await t.engine.approve(t.mem.tx, t.approval.id, "dev-approver", {}, false)).toEqual({
      ok: false,
      error: "public_not_acknowledged",
      audits: [],
    });
    expect(t.mem.approvals[0]!.status).toBe("pending");
    expect(t.mem.outbox).toHaveLength(1);
    expect((await t.engine.approve(t.mem.tx, t.approval.id, "dev-approver", {}, true)).ok).toBe(true);
    expect(t.mem.outbox[1]!.envelope.data).toMatchObject({ acknowledgedPublic: true });
  });

  it("reject: the approval rejected with the comment, the run ends rejected, nothing is published", async () => {
    const t = await waitingOnReview();
    const r = await t.engine.reject(t.mem.tx, t.approval.id, "dev-approver", "  Not an issue, a question.  ");
    expect(r).toEqual({
      ok: true,
      audits: [
        {
          action: "flow.approval.decided",
          runId: t.run.id,
          stepId: t.review.id,
          approvalId: t.approval.id,
          decision: "rejected",
          actor: "dev-approver",
        },
        { action: "flow.run.finished", runId: t.run.id, status: "rejected" },
      ],
    });
    expect(t.mem.approvals[0]).toMatchObject({
      status: "rejected",
      decidedBy: "dev-approver",
      decidedAt: t.clock.now,
      comment: "Not an issue, a question.",
    });
    expect(t.step("review")).toMatchObject({ status: "failed", errorCode: "rejected" });
    expect(t.onlyRun()).toMatchObject({ status: "rejected", endedAt: t.clock.now, errorCode: null });
    expect(t.mem.outbox).toHaveLength(1);
    // A rejected run isn't retried.
    expect(await t.engine.retry(t.mem.tx, t.run.id, "dev-admin")).toMatchObject({ ok: false, error: "not_retryable" });
  });

  it("reject: no comment is fine, one over 1000 characters is refused", async () => {
    const t = await waitingOnReview();
    expect(await t.engine.reject(t.mem.tx, t.approval.id, "a", "x".repeat(1001))).toMatchObject({
      ok: false,
      error: "invalid_comment",
    });
    expect((await t.engine.reject(t.mem.tx, t.approval.id, "a", "")).ok).toBe(true);
    expect(t.mem.approvals[0]!.comment).toBeNull();
  });

  it("deciding twice, or an approval that doesn't exist, is refused (not_pending, not_found)", async () => {
    const t = await waitingOnReview();
    expect((await t.engine.approve(t.mem.tx, t.approval.id, "a", {}, false)).ok).toBe(true);
    const before = structuredClone({ approvals: t.mem.approvals, steps: t.mem.steps, outbox: t.mem.outbox });
    expect(await t.engine.approve(t.mem.tx, t.approval.id, "b", {}, false)).toEqual({
      ok: false,
      error: "not_pending",
      audits: [],
    });
    expect(await t.engine.reject(t.mem.tx, t.approval.id, "b")).toMatchObject({ ok: false, error: "not_pending" });
    expect({ approvals: t.mem.approvals, steps: t.mem.steps, outbox: t.mem.outbox }).toEqual(before);
    expect(await t.engine.approve(t.mem.tx, "nope", "a", {}, false)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("a run that no longer waits on the approval refuses a decision (not_pending)", async () => {
    const t = await waitingOnReview();
    // As if the run had moved on without the approval (a bug, or a hand edit): the guard holds.
    t.mem.runs.get(t.run.id)!.status = "running";
    expect(await t.engine.approve(t.mem.tx, t.approval.id, "a", {}, false)).toMatchObject({ error: "not_pending" });
  });

  it("expiry: past the deadline nobody can decide; the sweeper expires it and fails the run (approval_expired)", async () => {
    const t = await waitingOnReview();
    t.advance(7 * DAY);
    expect(await t.engine.approve(t.mem.tx, t.approval.id, "a", {}, false)).toMatchObject({ error: "not_pending" });
    t.mem.lockedElsewhere.add(t.run.id);
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined(); // SKIP LOCKED
    t.mem.lockedElsewhere.clear();
    const swept = await t.engine.sweepOne(t.mem.tx);
    expect(swept).toEqual({
      runId: t.run.id,
      audits: [{ action: "flow.run.finished", runId: t.run.id, status: "failed", errorCode: "approval_expired" }],
    });
    expect(t.mem.approvals[0]).toMatchObject({ status: "expired", decidedBy: null });
    expect(t.step("review")).toMatchObject({ status: "timed_out", errorCode: "approval_expired" });
    expect(t.onlyRun()).toMatchObject({ status: "failed", errorCode: "approval_expired" });
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined();
    expect(await t.engine.reject(t.mem.tx, t.approval.id, "a")).toMatchObject({ error: "not_pending" });

    // A retry asks again: a NEW approval; the expired one stays expired.
    expect((await t.engine.retry(t.mem.tx, t.run.id, "dev-admin")).ok).toBe(true);
    expect(t.mem.approvals.map((a) => a.status)).toEqual(["expired", "pending"]);
    expect(t.step("review")).toMatchObject({ status: "waiting", attempts: 2, input: DRAFT });
  });

  it("cancel of a run with a pending approval cancels the approval; it can't be decided after", async () => {
    const t = await waitingOnReview();
    expect((await t.engine.cancel(t.mem.tx, t.run.id, "dev-admin")).ok).toBe(true);
    expect(t.mem.approvals[0]!.status).toBe("cancelled");
    expect(t.step("review")).toMatchObject({ status: "skipped", errorCode: "cancelled" });
    expect(await t.engine.approve(t.mem.tx, t.approval.id, "a", {}, false)).toMatchObject({ error: "not_pending" });
  });

  it("retry after the approval: the failed create step again, the approval stays decided", async () => {
    const t = await waitingOnReview();
    await t.engine.approve(t.mem.tx, t.approval.id, "dev-approver", { title: "Edited" }, false);
    const create = t.step("create");
    await t.engine.handle(
      t.mem.tx,
      t.outcome(ISSUE_FAILED, { runId: t.run.id, stepId: create.id, code: "github_unavailable" }),
    );
    expect(t.onlyRun()).toMatchObject({ status: "failed", errorCode: "github_unavailable" });

    const r = await t.engine.retry(t.mem.tx, t.run.id, "dev-admin");
    expect(r.audits).toEqual([
      { action: "flow.run.retried", runId: t.run.id, stepId: create.id, attempt: 2, actor: "dev-admin" },
    ]);
    expect(t.mem.approvals).toHaveLength(1);
    expect(t.mem.approvals[0]).toMatchObject({ status: "approved", edited: { title: "Edited" } });
    expect(t.step("review").status).toBe("succeeded");
    expect(t.step("create")).toMatchObject({ status: "waiting", attempts: 2 });
    expect(t.mem.outbox.map((o) => o.type)).toEqual([DRAFT_REQUESTED, ISSUE_APPROVED, ISSUE_APPROVED]);
    expect(t.mem.outbox[2]!.envelope.data).toMatchObject({ approvalId: t.approval.id, title: "Edited" });
    expect(t.mem.outbox[2]!.id).not.toBe(t.mem.outbox[1]!.id);
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
      audits: [
        {
          action: "flow.workflow.paused",
          workflow: "docs-note-to-issue",
          workflowId: t.mem.workflows[0]!.id,
          actor: "dev-admin",
        },
      ],
    });
    expect((await t.engine.setWorkflowStatus(t.mem.tx, "docs-note-to-issue", "paused", "dev-admin")).audits).toEqual(
      [],
    );
    expect(await t.engine.setWorkflowStatus(t.mem.tx, "docs-note-to-issue", "active", "dev-admin")).toEqual({
      ok: true,
      audits: [
        {
          action: "flow.workflow.resumed",
          workflow: "docs-note-to-issue",
          workflowId: t.mem.workflows[0]!.id,
          actor: "dev-admin",
        },
      ],
    });
    expect(await t.engine.setWorkflowStatus(t.mem.tx, "nope", "paused", "dev-admin")).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });
});
