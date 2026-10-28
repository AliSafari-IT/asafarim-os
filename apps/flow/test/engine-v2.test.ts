/**
 * The engine on v2 definitions (in-memory store, the real publisher): `startRun` and its refusals,
 * every node type (condition then/else, docs.issue-draft and docs.issue-create, approval with and
 * without a draft, wait, end, a connector), the connector's call (pending → running → the result in
 * one transition), its retries (5 s, 30 s, 2 min, then failed), a crashed call claimed again by the
 * sweeper (at least once), placeholders and `missing_value`, test and dry runs, and drafts (save,
 * publish, test run).
 */
import { ulid } from "@asafarim/app-sdk/events";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../lib/engine/connectors";
import { createEngine, LEASE_MARGIN_MS, type InboundEvent } from "../lib/engine/engine";
import { publisher } from "../lib/events";
import { parseDefinition, type AnyWorkflowDefinition } from "../lib/workflow/definition";
import manifest from "../platform.app";
import { echo, registerEcho } from "./echo-connector";
import { memoryDb } from "./memory-store";
import { clone, DOCS_FLOW, ECHO_FLOW } from "./v2-fixtures";

beforeAll(registerEcho);
beforeEach(() => echo.reset());

const parsed = (value: unknown): AnyWorkflowDefinition => {
  const r = parseDefinition(value);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.definition;
};

function setup(definition: unknown = ECHO_FLOW, status: "active" | "paused" = "active") {
  const mem = memoryDb();
  const clock = { now: new Date("2026-10-28T10:00:00.000Z") };
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
    manifest,
  });
  mem.publish(parsed(definition), status);
  const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  const run = (id: string) => mem.runs.get(id)!;
  const step = (runId: string, key: string) => mem.steps.find((s) => s.runId === runId && s.stepKey === key)!;
  const start = (data: Record<string, unknown>, more: { test?: boolean; dryRun?: boolean } = {}) =>
    engine.startRun(mem.tx, { workflowKey: "echo-flow", trigger: "manual", data, actor: "dev-owner", ...more });
  /** One pass of the connector worker: claim, call, complete. */
  async function work() {
    const claimed = await engine.claimConnector(mem.tx);
    if (!claimed?.claim) return claimed;
    const outcome = await engine.invokeConnector(claimed.claim);
    return { ...claimed, outcome, audits: await engine.completeConnector(mem.tx, claimed.claim, outcome) };
  }
  return { mem, engine, clock, logs, advance, run, step, start, work };
}

async function started(t: ReturnType<typeof setup>, data: Record<string, unknown>, more = {}) {
  const r = await t.start(data, more);
  if (!r.ok) throw new Error(r.error);
  return r.runId;
}

describe("startRun", () => {
  it("a manual run on the current version: the run, its audit entry, and the condition's else to the end", async () => {
    const t = setup();
    const r = await t.start({ name: "Ada", loud: false });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(t.run(r.runId)).toMatchObject({ status: "succeeded", test: false, dryRun: false, trigger: { name: "Ada" } });
    expect(t.step(r.runId, "check").output).toEqual({ passed: false });
    expect(t.mem.steps.map((s) => s.stepKey)).toEqual(["check", "done"]);
    expect(r.audits).toEqual([
      expect.objectContaining({
        action: "flow.run.started",
        runId: r.runId,
        workflow: "echo-flow",
        version: 1,
        actor: "dev-owner",
      }),
      { action: "flow.run.finished", runId: r.runId, status: "succeeded" },
    ]);
  });

  it("refuses: an unknown workflow, a paused one, another trigger type, data that doesn't fit, a duplicate event", async () => {
    const t = setup();
    expect(await t.engine.startRun(t.mem.tx, { workflowKey: "nope", trigger: "manual", data: {} })).toMatchObject({
      error: "not_found",
    });
    expect(
      await t.engine.startRun(t.mem.tx, { workflowKey: "echo-flow", trigger: "webhook", data: { name: "x" } }),
    ).toMatchObject({
      error: "wrong_trigger",
    });
    expect(await t.start({ loud: "yes" })).toMatchObject({
      ok: false,
      error: "invalid_input",
      problems: [
        { path: "", message: "name: is required" },
        { path: "", message: "loud: must be a boolean" },
      ],
    });
    const id = ulid();
    await t.engine.startRun(t.mem.tx, {
      workflowKey: "echo-flow",
      trigger: "manual",
      data: { name: "a" },
      triggerEventId: id,
    });
    expect(
      await t.engine.startRun(t.mem.tx, {
        workflowKey: "echo-flow",
        trigger: "manual",
        data: { name: "a" },
        triggerEventId: id,
      }),
    ).toMatchObject({
      error: "duplicate",
    });
    const paused = setup(ECHO_FLOW, "paused");
    expect(await paused.start({ name: "a" })).toMatchObject({ error: "not_active" });
    expect(await paused.start({ name: "a" }, { test: true })).toMatchObject({ ok: true });
    expect(t.mem.runs.size).toBe(1);
  });

  it("Settings paused_all: no run starts, whatever the trigger; only a dry run (which calls nothing) does", async () => {
    const t = setup();
    t.mem.settings.pausedAll = true;
    expect(await t.start({ name: "a" })).toMatchObject({ ok: false, error: "paused_all" });
    expect(await t.start({ name: "a" }, { test: true })).toMatchObject({ ok: false, error: "paused_all" });
    expect(await t.start({ name: "a" }, { dryRun: true })).toMatchObject({ ok: true });
    expect([...t.mem.runs.values()].map((r) => r.dryRun)).toEqual([true]);
  });

  it("an event trigger: the event starts the v2 workflow through startRun", async () => {
    const t = setup(DOCS_FLOW);
    const audits = await t.engine.handle(t.mem.tx, {
      id: ulid(),
      type: "docs.note.created.v1",
      data: {
        id: "42",
        author: "dev-admin",
        docPath: "a.md",
        tags: ["idea"],
        hasIssue: false,
        createdAt: "2026-10-28T10:00:00.000Z",
      },
    });
    const [run] = [...t.mem.runs.values()];
    expect(run).toMatchObject({ status: "skipped" });
    expect(t.mem.steps.map((s) => [s.stepKey, s.status])).toEqual([
      ["only-tagged", "succeeded"],
      ["not-tagged", "succeeded"],
    ]);
    expect(audits.map((a) => a.action)).toEqual(["flow.run.started", "flow.run.finished"]);
  });
});

describe("the Docs nodes and an approval that reviews a draft", () => {
  const NOTE = {
    id: "42",
    author: "dev-admin",
    docPath: "a.md",
    tags: ["issue"],
    hasIssue: false,
    createdAt: "2026-10-28T10:00:00.000Z",
  };
  const DRAFT = {
    noteId: "42",
    docPath: "a.md",
    repo: "AliSafari-IT/asafarim-docs",
    public: false,
    title: "T",
    body: "B",
    labels: [],
  };

  it("draft → approval (edits only what is editable) → create: the slice-1 requests and outcomes", async () => {
    const t = setup(DOCS_FLOW);
    await t.engine.handle(t.mem.tx, { id: ulid(), type: "docs.note.created.v1", data: NOTE });
    const [run] = [...t.mem.runs.values()];
    const draft = t.step(run!.id, "draft");
    expect(t.mem.outbox.map((o) => o.type)).toEqual(["flow.issue-draft.requested.v1"]);
    expect(draft).toMatchObject({ status: "waiting", requestEventId: t.mem.outbox[0]!.id });
    expect(draft.timeoutAt).toEqual(new Date("2026-10-28T10:05:00.000Z"));

    const ready: InboundEvent = {
      id: ulid(),
      type: "docs.issue-draft.ready.v1",
      data: { runId: run!.id, stepId: draft.id, requestId: draft.requestEventId, ...DRAFT },
    };
    await t.engine.handle(t.mem.tx, ready);
    expect(t.step(run!.id, "review")).toMatchObject({ status: "waiting", input: DRAFT });
    const [approval] = t.mem.approvals;
    expect(await t.engine.approve(t.mem.tx, approval!.id, "dev-approver", { body: "changed" }, false)).toMatchObject({
      error: "edit_not_allowed",
    });
    expect(await t.engine.approve(t.mem.tx, approval!.id, "dev-approver", { title: "Better" }, false)).toMatchObject({
      ok: true,
    });
    expect(t.mem.outbox.map((o) => o.type)).toEqual(["flow.issue-draft.requested.v1", "flow.issue.approved.v1"]);
    expect(t.mem.outbox[1]!.envelope.data).toMatchObject({ approvalId: approval!.id, title: "Better", noteId: "42" });

    const create = t.step(run!.id, "create");
    await t.engine.handle(t.mem.tx, {
      id: ulid(),
      type: "docs.issue.created.v1",
      data: {
        runId: run!.id,
        stepId: create.id,
        requestId: create.requestEventId,
        noteId: "42",
        issueUrl: "https://github.com/x/y/issues/1",
      },
    });
    expect(t.run(run!.id)).toMatchObject({ status: "succeeded" });
  });
});

describe("an approval that reviews nothing", () => {
  const FLOW = {
    ...clone(ECHO_FLOW),
    start: "ok",
    nodes: [
      { key: "ok", type: "approval", role: "flow.approver", deadline: "P1D", onExpire: "stop", next: "done" },
      { key: "done", type: "end" },
    ],
  };

  it("waits for a person with no input; approved, it takes no edits and goes on", async () => {
    const t = setup(FLOW);
    const runId = await started(t, { name: "x" });
    expect(t.run(runId).status).toBe("waiting");
    expect(t.step(runId, "ok")).toMatchObject({ status: "waiting", input: null });
    const [a] = t.mem.approvals;
    expect(await t.engine.approve(t.mem.tx, a!.id, "dev-approver", { title: "x" }, false)).toMatchObject({
      error: "edit_not_allowed",
    });
    expect(await t.engine.approve(t.mem.tx, a!.id, "dev-approver", {}, false)).toMatchObject({ ok: true });
    expect(t.step(runId, "ok").output).toEqual({
      approvalId: a!.id,
      decidedBy: "dev-approver",
      decidedAt: t.clock.now.toISOString(),
    });
    expect(t.run(runId).status).toBe("succeeded");
  });

  it("still waits in a test run and in a dry run", async () => {
    const t = setup(FLOW);
    for (const more of [{ test: true }, { dryRun: true }]) {
      const runId = await started(t, { name: "x" }, more);
      expect(t.run(runId)).toMatchObject({ status: "waiting", test: true, dryRun: "dryRun" in more });
    }
  });
});

describe("wait", () => {
  const FLOW = {
    ...clone(ECHO_FLOW),
    start: "pause",
    nodes: [
      { key: "pause", type: "wait", duration: "PT10M", next: "done" },
      { key: "done", type: "end" },
    ],
  };

  it("waits until its time, then the sweeper resumes the run at the next node", async () => {
    const t = setup(FLOW);
    const runId = await started(t, { name: "x" });
    expect(t.run(runId).status).toBe("waiting");
    expect(t.step(runId, "pause")).toMatchObject({
      status: "waiting",
      timeoutAt: new Date("2026-10-28T10:10:00.000Z"),
    });
    t.advance(9 * 60_000);
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined();
    t.advance(60_000);
    const swept = await t.engine.sweepOne(t.mem.tx);
    expect(swept?.audits).toEqual([{ action: "flow.run.finished", runId, status: "succeeded" }]);
    expect(t.step(runId, "pause")).toMatchObject({ status: "succeeded", timeoutAt: null });
    expect(t.run(runId).status).toBe("succeeded");
  });

  it("a run another instance holds is skipped (SKIP LOCKED)", async () => {
    const t = setup(FLOW);
    const runId = await started(t, { name: "x" });
    t.advance(11 * 60_000);
    t.mem.lockedElsewhere.add(runId);
    expect(await t.engine.sweepOne(t.mem.tx)).toBeUndefined();
  });

  it("a dry run doesn't wait", async () => {
    const t = setup(FLOW);
    const runId = await started(t, { name: "x" }, { dryRun: true });
    expect(t.run(runId).status).toBe("succeeded");
    expect(t.step(runId, "pause")).toMatchObject({ status: "succeeded", input: { until: "2026-10-28T10:10:00.000Z" } });
  });
});

describe("a connector node (test.echo)", () => {
  it("pending and due at once; claimed it is running; its result and the next transition are written together", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    expect(t.run(runId).status).toBe("running");
    expect(t.step(runId, "shout")).toMatchObject({
      status: "pending",
      attempts: 0,
      input: { text: "Hello Ada!" },
      timeoutAt: t.clock.now,
    });

    const claimed = await t.engine.claimConnector(t.mem.tx);
    expect(claimed?.claim).toMatchObject({
      runId,
      attempt: 1,
      type: "test.echo",
      input: { text: "Hello Ada!" },
      test: false,
    });
    expect(t.step(runId, "shout")).toMatchObject({ status: "running", attempts: 1 });
    expect(t.step(runId, "shout").timeoutAt).toEqual(new Date(t.clock.now.getTime() + 50 + LEASE_MARGIN_MS));
    expect(await t.engine.claimConnector(t.mem.tx)).toBeUndefined(); // in flight: nobody else claims it

    const outcome = await t.engine.invokeConnector(claimed!.claim!);
    expect(outcome).toEqual({ ok: true, output: { text: "Hello Ada!" } });
    expect(echo.calls[0]!.ctx).toMatchObject({ runId, stepId: t.step(runId, "shout").id, attempt: 1, test: false });
    const audits = await t.engine.completeConnector(t.mem.tx, claimed!.claim!, outcome);
    expect(t.step(runId, "shout")).toMatchObject({
      status: "succeeded",
      output: { text: "Hello Ada!" },
      timeoutAt: null,
    });
    expect(t.run(runId).status).toBe("succeeded");
    expect(audits).toEqual([{ action: "flow.run.finished", runId, status: "succeeded" }]);
  });

  it("a retryable failure: tried again after 5 s, 30 s, 2 min; the fourth failure fails the step and the run", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    echo.script = Array.from({ length: 4 }, () => ({ fail: new ConnectorError("rate_limited", true, "Slow down.") }));
    for (const wait of [5_000, 30_000, 120_000]) {
      await t.work();
      const s = t.step(runId, "shout");
      expect(s).toMatchObject({ status: "pending", errorCode: "rate_limited", errorMessage: "Slow down." });
      expect(s.timeoutAt).toEqual(new Date(t.clock.now.getTime() + wait));
      t.advance(wait - 1);
      expect(await t.engine.claimConnector(t.mem.tx)).toBeUndefined();
      t.advance(1);
    }
    await t.work();
    expect(t.step(runId, "shout")).toMatchObject({
      status: "failed",
      attempts: 4,
      autoRetries: 3,
      errorCode: "rate_limited",
    });
    expect(t.run(runId)).toMatchObject({ status: "failed", errorCode: "rate_limited" });
    expect(echo.calls).toHaveLength(4);
  });

  it("a retryable failure then success goes on", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    echo.script = [{ throw: new TypeError("socket hang up with a token=abc") }];
    await t.work();
    expect(t.step(runId, "shout")).toMatchObject({
      status: "pending",
      errorCode: "connector_error",
      errorMessage: "The connector failed unexpectedly.",
    });
    t.advance(5_000);
    await t.work();
    expect(t.run(runId).status).toBe("succeeded");
    expect(t.logs.find((l) => l.msg === "flow.connector.threw")?.fields).toMatchObject({ error: "TypeError" });
  });

  it("a failure that isn't retryable, an output that doesn't fit: the step fails at once", async () => {
    for (const [script, code] of [
      [{ fail: new ConnectorError("bad_address", false, "No such address.") }, "bad_address"],
      ["bad-output", "invalid_output"],
    ] as const) {
      echo.reset();
      const t = setup();
      const runId = await started(t, { name: "Ada", loud: true });
      echo.script = [script];
      await t.work();
      expect(t.step(runId, "shout")).toMatchObject({ status: "failed", errorCode: code });
      expect(t.run(runId)).toMatchObject({ status: "failed", errorCode: code });
    }
  });

  it("a call that doesn't answer in time is a retryable timeout", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    echo.script = ["hang"];
    const r = await t.work();
    expect(r && "outcome" in r ? r.outcome : undefined).toEqual({
      ok: false,
      code: "timeout",
      retryable: true,
      message: "No answer within 50 ms.",
    });
    expect(t.step(runId, "shout")).toMatchObject({ status: "pending", errorCode: "timeout" });
  });

  it("a crash mid-call: the step stays running; once its lease ran out the sweeper claims it again (at least once)", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    const first = (await t.engine.claimConnector(t.mem.tx))!.claim!;
    await t.engine.invokeConnector(first); // … and the process dies before writing the result
    t.advance(50 + LEASE_MARGIN_MS - 1);
    expect(await t.engine.claimConnector(t.mem.tx)).toBeUndefined();
    t.advance(1);
    const second = (await t.engine.claimConnector(t.mem.tx))!.claim!;
    expect(second).toMatchObject({ runId, stepId: first.stepId, attempt: 2 });
    expect(t.step(runId, "shout")).toMatchObject({ status: "running", attempts: 2, autoRetries: 1 });
    expect(t.logs.some((l) => l.msg === "flow.connector.lease_expired")).toBe(true);
    // The first call's result, should it arrive late, is dropped: the step is the second call's now.
    expect(await t.engine.completeConnector(t.mem.tx, first, { ok: true, output: { text: "late" } })).toEqual([]);
    await t.engine.completeConnector(t.mem.tx, second, await t.engine.invokeConnector(second));
    expect(t.run(runId).status).toBe("succeeded");
    expect(echo.calls).toHaveLength(2);
  });

  it("interrupted every time: after the retries, the step fails `interrupted`", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    for (let i = 0; i < 4; i++) {
      expect((await t.engine.claimConnector(t.mem.tx))?.claim).toBeDefined();
      t.advance(50 + LEASE_MARGIN_MS);
    }
    expect((await t.engine.claimConnector(t.mem.tx))?.claim).toBeUndefined();
    expect(t.run(runId)).toMatchObject({ status: "failed", errorCode: "interrupted" });
  });

  it("cancelled while in flight: the result is dropped", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    const claim = (await t.engine.claimConnector(t.mem.tx))!.claim!;
    await t.engine.cancel(t.mem.tx, runId, "dev-owner");
    expect(await t.engine.completeConnector(t.mem.tx, claim, { ok: true, output: { text: "x" } })).toEqual([]);
    expect(t.step(runId, "shout").status).toBe("skipped");
  });

  it("a placeholder with no value fails the step `missing_value`; retry fills it again", async () => {
    const t = setup({
      ...clone(ECHO_FLOW),
      trigger: {
        type: "manual",
        input: [
          { name: "name", type: "string" },
          { name: "loud", type: "boolean" },
        ],
      },
    });
    const runId = await started(t, { loud: true });
    expect(t.step(runId, "shout")).toMatchObject({
      status: "failed",
      errorCode: "missing_value",
      errorMessage: "{{trigger.name}} has no value in this run",
    });
    expect(t.run(runId)).toMatchObject({ status: "failed", errorCode: "missing_value" });
    expect(echo.calls).toEqual([]);
  });

  it("a value holding a placeholder is sent as text, never evaluated (injection)", async () => {
    const t = setup();
    const runId = await started(t, { name: "{{trigger.loud}}", loud: true });
    expect(t.step(runId, "shout").input).toEqual({ text: "Hello {{trigger.loud}}!" });
  });

  it("a failed connector step is retried by hand with a fresh set of retries", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true });
    echo.script = [{ fail: new ConnectorError("nope", false, "No.") }];
    await t.work();
    expect(t.run(runId).status).toBe("failed");
    expect(await t.engine.retry(t.mem.tx, runId, "dev-owner")).toMatchObject({ ok: true });
    expect(t.step(runId, "shout")).toMatchObject({ status: "pending", attempts: 1, autoRetries: 0, errorCode: null });
    await t.work();
    expect(t.run(runId).status).toBe("succeeded");
  });

  it("a test run calls it for real, and says so in ctx.test", async () => {
    const t = setup();
    const runId = await started(t, { name: "Ada", loud: true }, { test: true });
    await t.work();
    expect(echo.calls[0]!.ctx.test).toBe(true);
    expect(t.run(runId)).toMatchObject({ status: "succeeded", test: true, dryRun: false });
  });

  it("a dry run calls nothing: it records the input it would send and the simulated output", async () => {
    const t = setup();
    const r = await t.start({ name: "Ada", loud: true }, { dryRun: true });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(t.run(r.runId)).toMatchObject({ status: "succeeded", test: true, dryRun: true });
    expect(t.step(r.runId, "shout")).toMatchObject({
      status: "succeeded",
      input: { text: "Hello Ada!" },
      output: { text: "(simulated) Hello Ada!" },
    });
    expect(echo.calls).toEqual([]);
    expect(await t.engine.claimConnector(t.mem.tx)).toBeUndefined();
    expect(r.audits[0]).toMatchObject({ action: "flow.run.started", test: true, dryRun: true });
  });

  it("a dry run of the Docs graph publishes nothing: the request it would send, a simulated draft, and the approval waits", async () => {
    const t = setup(DOCS_FLOW);
    const r = await t.engine.startRun(t.mem.tx, {
      workflowKey: "docs-note-to-issue-v2",
      trigger: "event",
      data: { id: "42", author: "dev-admin", tags: ["issue"] },
      dryRun: true,
    });
    if (!r.ok) throw new Error(r.error);
    expect(t.mem.outbox).toEqual([]);
    expect(t.step(r.runId, "draft")).toMatchObject({
      status: "succeeded",
      input: { runId: r.runId, noteId: "42", onBehalfOf: "dev-admin" },
      output: { noteId: "42", repo: "dry-run/dry-run", public: false },
    });
    expect(t.run(r.runId).status).toBe("waiting");
    const [a] = t.mem.approvals;
    await t.engine.approve(t.mem.tx, a!.id, "dev-approver", {}, false);
    expect(t.mem.outbox).toEqual([]);
    expect(t.step(r.runId, "create").output).toEqual({
      noteId: "42",
      issueUrl: "https://github.com/dry-run/dry-run/issues/0",
    });
    expect(t.run(r.runId).status).toBe("succeeded");
  });
});

describe("drafts", () => {
  it("save (stored as it is, problems by node), refuse to publish while invalid, publish a new version, run it", async () => {
    const t = setup();
    const bad = clone(ECHO_FLOW) as unknown as { nodes: Record<string, unknown>[] };
    bad.nodes[1]!.next = "nowhere";
    const saved = await t.engine.saveDraft(t.mem.tx, { workflowKey: "echo-flow", definition: bad, actor: "dev-owner" });
    expect(saved).toEqual({
      ok: true,
      problems: [{ node: "shout", path: "next", message: 'goes to "nowhere", which isn\'t a node' }],
      workflowId: t.mem.workflows[0]!.id,
      draftUpdatedAt: t.clock.now,
      audits: [{ action: "flow.workflow.draft_saved", workflow: "echo-flow", actor: "dev-owner" }],
    });
    expect(t.mem.workflows[0]).toMatchObject({
      draftDefinition: bad,
      draftUpdatedBy: "dev-owner",
      draftUpdatedAt: t.clock.now,
    });
    expect(await t.engine.publishDraft(t.mem.tx, { workflowKey: "echo-flow", actor: "dev-owner" })).toMatchObject({
      ok: false,
      error: "invalid_definition",
      problems: [{ node: "shout", path: "next" }],
    });
    expect(
      await t.engine.startDraftRun(t.mem.tx, { workflowKey: "echo-flow", data: {}, dryRun: true, actor: "x" }),
    ).toMatchObject({
      error: "invalid_definition",
    });

    const good = clone(ECHO_FLOW) as unknown as { nodes: Record<string, unknown>[] };
    good.nodes[1]!.input = { text: "Bye {{trigger.name}}" };
    expect(
      await t.engine.saveDraft(t.mem.tx, { workflowKey: "echo-flow", definition: good, actor: "dev-owner" }),
    ).toMatchObject({
      ok: true,
      problems: [],
    });

    // A test run of the draft carries its definition; the published version is untouched.
    const test = await t.engine.startDraftRun(t.mem.tx, {
      workflowKey: "echo-flow",
      data: { name: "Ada", loud: true },
      dryRun: false,
      actor: "dev-owner",
    });
    if (!test.ok) throw new Error(test.error);
    expect(t.run(test.runId)).toMatchObject({
      test: true,
      dryRun: false,
      versionId: null,
      draftDefinition: { key: "echo-flow" },
    });
    expect(test.audits[0]).toMatchObject({ action: "flow.run.started", test: true, actor: "dev-owner" });
    expect(test.audits[0]).not.toHaveProperty("version");
    await t.work();
    expect(t.step(test.runId, "shout").output).toEqual({ text: "Bye Ada" });

    const published = await t.engine.publishDraft(t.mem.tx, { workflowKey: "echo-flow", actor: "dev-owner" });
    expect(published).toEqual({
      ok: true,
      version: 2,
      audits: [
        {
          action: "flow.workflow.published",
          workflow: "echo-flow",
          workflowId: t.mem.workflows[0]!.id,
          version: 2,
          actor: "dev-owner",
        },
      ],
    });
    expect(t.mem.workflows[0]!.draftDefinition).toBeNull();
    expect(t.mem.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(await t.engine.publishDraft(t.mem.tx, { workflowKey: "echo-flow", actor: "dev-owner" })).toMatchObject({
      error: "no_draft",
    });
    const runId = await started(t, { name: "Bo", loud: true });
    expect(t.run(runId).versionId).toBe(t.mem.versions[1]!.id);
  });

  it("a new key makes a new workflow; a draft that isn't an object of the workflow's key is refused", async () => {
    const t = setup();
    const fresh = { ...clone(ECHO_FLOW), key: "brand-new" };
    expect(
      await t.engine.saveDraft(t.mem.tx, {
        workflowKey: "brand-new",
        name: "Brand new",
        definition: fresh,
        actor: "a",
      }),
    ).toMatchObject({
      ok: true,
      problems: [],
    });
    expect(t.mem.workflows.find((w) => w.key === "brand-new")).toMatchObject({
      name: "Brand new",
      draftDefinition: fresh,
    });
    for (const definition of [null, [], "x", { ...fresh, key: "other" }, { ...fresh, pad: "x".repeat(300_000) }]) {
      expect(await t.engine.saveDraft(t.mem.tx, { workflowKey: "brand-new", definition, actor: "a" })).toMatchObject({
        error: "invalid_draft",
      });
    }
  });

  it("a save made from a draft someone else saved since is refused (stale_draft), not saved over theirs", async () => {
    const t = setup();
    const def = clone(ECHO_FLOW);
    const save = (draftUpdatedAt: Date | null, actor: string) =>
      t.engine.saveDraft(t.mem.tx, { workflowKey: "echo-flow", definition: def, actor, expect: { draftUpdatedAt } });
    // No draft yet: the editor saw none.
    const first = await save(null, "ada");
    if (!first.ok) throw new Error(first.error);
    // Bo opened it before Ada's save: Bo's save names "no draft", which is stale now.
    t.advance(1000);
    expect(await save(null, "bo")).toEqual({ ok: false, error: "stale_draft", audits: [] });
    t.advance(1000);
    expect(t.mem.workflows[0]).toMatchObject({ draftUpdatedBy: "ada", draftUpdatedAt: first.draftUpdatedAt });
    // Ada's next save names her last one: it goes through, and the one after names it in turn.
    const second = await save(first.draftUpdatedAt, "ada");
    if (!second.ok) throw new Error(second.error);
    expect(second.draftUpdatedAt.getTime()).toBeGreaterThan(first.draftUpdatedAt.getTime());
    expect(await save(first.draftUpdatedAt, "ada")).toMatchObject({ error: "stale_draft" });
    // After a publish there is no draft: the next save names none.
    await t.engine.publishDraft(t.mem.tx, { workflowKey: "echo-flow", actor: "ada" });
    expect(await save(second.draftUpdatedAt, "ada")).toMatchObject({ error: "stale_draft" });
    expect(await save(null, "ada")).toMatchObject({ ok: true });
    // A workflow that doesn't exist isn't made by such a save.
    expect(
      await t.engine.saveDraft(t.mem.tx, {
        workflowKey: "nope",
        definition: { ...def, key: "nope" },
        actor: "ada",
        expect: { draftUpdatedAt: null },
      }),
    ).toMatchObject({ error: "not_found" });
    expect(t.mem.workflows.map((w) => w.key)).not.toContain("nope");
  });

  it('expect "new" makes a workflow, and refuses a key that exists (exists)', async () => {
    const t = setup();
    const def = { ...clone(ECHO_FLOW), key: "fresh" };
    expect(
      await t.engine.saveDraft(t.mem.tx, { workflowKey: "fresh", definition: def, actor: "a", expect: "new" }),
    ).toMatchObject({ ok: true });
    expect(
      await t.engine.saveDraft(t.mem.tx, { workflowKey: "fresh", definition: def, actor: "b", expect: "new" }),
    ).toEqual({ ok: false, error: "exists", audits: [] });
    expect(t.mem.workflows.find((w) => w.key === "fresh")?.draftUpdatedBy).toBe("a");
  });

  it("publishDraft's check refuses a draft that validates, with its problems", async () => {
    const t = setup();
    await t.engine.saveDraft(t.mem.tx, { workflowKey: "echo-flow", definition: clone(ECHO_FLOW), actor: "a" });
    const seen: unknown[] = [];
    const refused = await t.engine.publishDraft(t.mem.tx, {
      workflowKey: "echo-flow",
      actor: "a",
      check: async (draft) => {
        seen.push(draft);
        return [{ node: "shout", path: "input.credential", message: "choose a credential" }];
      },
    });
    expect(refused).toEqual({
      ok: false,
      error: "invalid_definition",
      problems: [{ node: "shout", path: "input.credential", message: "choose a credential" }],
      audits: [],
    });
    expect(seen).toEqual([clone(ECHO_FLOW)]);
    expect(t.mem.versions.map((v) => v.version)).toEqual([1]);
    expect(
      await t.engine.publishDraft(t.mem.tx, { workflowKey: "echo-flow", actor: "a", check: async () => [] }),
    ).toMatchObject({ ok: true, version: 2 });
  });

  it("checkDefinition: the problems a draft would be refused with", () => {
    const t = setup();
    expect(t.engine.checkDefinition(clone(ECHO_FLOW))).toEqual([]);
    const bad = clone(ECHO_FLOW) as unknown as { nodes: Record<string, unknown>[] };
    bad.nodes[1]!.next = "nowhere";
    expect(t.engine.checkDefinition(bad)).toEqual([
      { node: "shout", path: "next", message: 'goes to "nowhere", which isn\'t a node' },
    ]);
  });

  it("a draft must fit the manifest to be published", async () => {
    const t = setup();
    const def = { ...clone(DOCS_FLOW), key: "echo-flow", trigger: { type: "event", event: "docs.note.deleted.v1" } };
    await t.engine.saveDraft(t.mem.tx, { workflowKey: "echo-flow", definition: def, actor: "a" });
    expect(await t.engine.publishDraft(t.mem.tx, { workflowKey: "echo-flow", actor: "a" })).toMatchObject({
      error: "invalid_definition",
      problems: [{ path: "", message: "the trigger docs.note.deleted.v1 isn't in events.subscribes" }],
    });
  });
});
