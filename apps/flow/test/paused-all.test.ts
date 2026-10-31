/**
 * The kill switch in the engine: while Settings `paused_all` is on, a trigger starts no run (on any
 * workflow), the refusal is logged and audited; once it is off, the next trigger starts one as usual.
 */
import { ulid } from "@asafarim/app-sdk/events";
import { describe, expect, it } from "vitest";
import { createEngine, type InboundEvent } from "../lib/engine/engine";
import { publisher } from "../lib/events";
import { getSettings, isPausedAll } from "../lib/settings";
import { DOCS_NOTE_TO_ISSUE } from "../lib/workflow/seed";
import { memoryDb } from "./memory-store";

const note = (): InboundEvent => ({
  id: ulid(),
  type: "docs.note.created.v1",
  data: {
    id: "42",
    author: "dev-admin",
    docPath: "guides/getting-started.md",
    tags: ["issue"],
    hasIssue: false,
    createdAt: "2026-10-26T10:00:00.000Z",
  },
});

describe("Pause all", () => {
  it("no new run starts while it is on; it is logged and audited; off again, runs start", async () => {
    const mem = memoryDb();
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = {
      info: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
      warn: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
    };
    const engine = createEngine({
      store: () => mem.store,
      publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
      newId: () => ulid(),
      log,
    });
    mem.publish(DOCS_NOTE_TO_ISSUE.definition);

    mem.settings.pausedAll = true;
    const event = note();
    expect(await engine.handle(mem.tx, event)).toEqual([
      { action: "flow.run.refused", triggerEventId: event.id, errorCode: "paused_all" },
    ]);
    expect(mem.runs.size).toBe(0);
    expect(mem.outbox).toEqual([]);
    expect(logs).toContainEqual({
      msg: "flow.trigger.paused_all",
      fields: { eventId: event.id, type: "docs.note.created.v1" },
    });

    mem.settings.pausedAll = false;
    await engine.handle(mem.tx, note());
    expect(mem.runs.size).toBe(1);
  });
});

/** #307 A1: work already under way must not publish a request while Pause all is on. */
describe("Pause all and work in flight", () => {
  const DRAFT = {
    noteId: "42",
    docPath: "guides/getting-started.md",
    repo: "AliSafari-IT/asafarim-docs",
    public: false,
    title: "Fix the getting-started guide",
    body: "## Context\n\nThe install step is out of date.",
    labels: ["docs"],
  };

  function setup(definition: Parameters<ReturnType<typeof memoryDb>["publish"]>[0] = DOCS_NOTE_TO_ISSUE.definition) {
    const mem = memoryDb();
    const clock = { now: new Date("2026-10-26T10:00:00.000Z") };
    const engine = createEngine({
      store: () => mem.store,
      publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
      newId: () => ulid(),
      now: () => clock.now,
      log: { info: () => undefined, warn: () => undefined },
    });
    mem.publish(definition);
    const advance = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
    const step = (key: string) => mem.steps.find((s) => s.stepKey === key)!;
    return { mem, engine, advance, step };
  }

  /** A run that waits on the approval of a drafted issue. */
  async function waitingOnApproval() {
    const t = setup();
    await t.engine.handle(t.mem.tx, note());
    const run = [...t.mem.runs.values()][0]!;
    const draft = t.step("draft");
    await t.engine.handle(t.mem.tx, {
      id: ulid(),
      type: "docs.issue-draft.ready.v1",
      data: { runId: run.id, stepId: draft.id, requestId: draft.requestEventId, ...DRAFT },
    });
    return { ...t, run, approval: t.mem.approvals.at(-1)! };
  }

  it("approving a step while paused is refused: the approval stays pending and nothing is published", async () => {
    const t = await waitingOnApproval();
    const before = t.mem.outbox.length;
    t.mem.settings.pausedAll = true;

    expect(await t.engine.approve(t.mem.tx, t.approval.id, "dev-approver", {}, false)).toEqual({
      ok: false,
      error: "paused_all",
      audits: [],
    });
    expect(t.mem.approvals.at(-1)).toMatchObject({ status: "pending", decidedBy: null });
    expect(t.mem.outbox).toHaveLength(before);

    t.mem.settings.pausedAll = false;
    expect((await t.engine.approve(t.mem.tx, t.approval.id, "dev-approver", {}, false)).ok).toBe(true);
    expect(t.mem.outbox).toHaveLength(before + 1);
  });

  it("retrying a failed run while paused is refused: the run stays failed and nothing is published", async () => {
    const t = setup();
    await t.engine.handle(t.mem.tx, note());
    const run = [...t.mem.runs.values()][0]!;
    t.advance(6 * 60_000);
    await t.engine.sweepOne(t.mem.tx);
    expect(t.mem.runs.get(run.id)).toMatchObject({ status: "failed", errorCode: "action_timeout" });
    const before = t.mem.outbox.length;
    t.mem.settings.pausedAll = true;

    expect(await t.engine.retry(t.mem.tx, run.id, "dev-admin")).toEqual({
      ok: false,
      error: "paused_all",
      audits: [],
    });
    expect(t.mem.runs.get(run.id)).toMatchObject({ status: "failed", errorCode: "action_timeout" });
    expect(t.mem.outbox).toHaveLength(before);

    t.mem.settings.pausedAll = false;
    expect((await t.engine.retry(t.mem.tx, run.id, "dev-admin")).ok).toBe(true);
    expect(t.mem.outbox).toHaveLength(before + 1);
  });

  it("a wait that ends while paused does not publish the request after it: the step fails with paused_all", async () => {
    const t = setup({
      version: 2,
      key: "wait-then-draft",
      trigger: { type: "event", event: "docs.note.created.v1" },
      start: "hold",
      nodes: [
        { key: "hold", type: "wait", duration: "PT1M", next: "draft" },
        { key: "draft", type: "docs.issue-draft", next: "end" },
        { key: "end", type: "end" },
      ],
    } as never);
    await t.engine.handle(t.mem.tx, note());
    const run = [...t.mem.runs.values()][0]!;
    expect(run.status).toBe("waiting");
    t.mem.settings.pausedAll = true;
    t.advance(2 * 60_000);

    await t.engine.sweepOne(t.mem.tx);

    expect(t.mem.outbox).toEqual([]);
    expect(t.step("draft")).toMatchObject({ status: "failed", errorCode: "paused_all" });
    expect(t.mem.runs.get(run.id)).toMatchObject({ status: "failed", errorCode: "paused_all" });
  });
});

/** #307 A2: a stored `paused_all` that is not a boolean counts as paused. */
describe("a malformed paused_all value", () => {
  it.each([["yes"], [1], [null], ["false"], [{ on: true }]])(
    "%j is treated as paused: no run starts, and the problem is logged",
    async (garbage) => {
      const mem = memoryDb();
      const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
      const warn = (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields });
      const engine = createEngine({
        store: () => mem.store,
        publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
        newId: () => ulid(),
        log: { info: warn, warn },
      });
      mem.publish(DOCS_NOTE_TO_ISSUE.definition);
      mem.settings.pausedAll = garbage;

      const event = note();
      expect(await engine.handle(mem.tx, event)).toEqual([
        { action: "flow.run.refused", triggerEventId: event.id, errorCode: "paused_all" },
      ]);
      expect(mem.runs.size).toBe(0);
      expect(logs.map((l) => l.msg)).toContain("flow.settings.paused_all_malformed");
    },
  );

  it("the settings readers agree: isPausedAll and getSettings say paused, a missing row says not paused", async () => {
    const q = (rows: unknown[]) => ({ query: async () => ({ rows, rowCount: rows.length }) });
    const warnings: string[] = [];
    const log = { warn: (msg: string) => warnings.push(msg) };
    expect(await isPausedAll(q([{ value: "garbage" }]), log)).toBe(true);
    expect(warnings).toEqual(["flow.settings.paused_all_malformed"]);
    expect((await getSettings(q([{ key: "paused_all", value: "garbage" }]))).pausedAll).toBe(true);
    expect(await isPausedAll(q([]))).toBe(false);
    expect(await isPausedAll(q([{ value: false }]))).toBe(false);
    expect(await isPausedAll(q([{ value: true }]))).toBe(true);
  });
});
