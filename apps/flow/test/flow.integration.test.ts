/**
 * Flow against a REAL Postgres: its migrations and seed, the engine on the Postgres store, the inbox
 * (the SDK's `processDelivery`, the function `subscribe` runs per message, with a stand-in for the
 * JetStream message) and the outbox in the same transaction:
 *
 *  1. a `docs.note.created.v1` with `#issue` creates a run that waits on the draft step, with a
 *     `flow.issue-draft.requested.v1` in the outbox;
 *  2. without the tag the run is `skipped`, and nothing is published;
 *  3. the same event delivered again creates nothing (the inbox; and trigger_event_id behind it);
 *  4. the sweeper times a run out, skipping one another connection holds (FOR UPDATE SKIP LOCKED);
 *     retry publishes a new request; retention clears old payloads; versions are immutable;
 *  5. the approval: Docs' draft opens a pending approval; approve (with edits) publishes
 *     flow.issue.approved.v1 in the same transaction; reject, expiry (the sweeper) and cancel;
 *  6. definition v2: a draft saved, published as version 2 and run by hand, `manual → condition →
 *     test.echo → end`, the connector called by the worker (`runDueConnectors`); a crashed call claimed
 *     again, skipping a run another connection holds; a wait resumed by the sweeper; a dry run.
 *
 * Needs FLOW_TEST_ADMIN_URL (or EVENTS_TEST_ADMIN_URL): a superuser URL on a DEV Postgres. Skipped
 * without it. It uses a throwaway database, dropped afterwards. No bus: the relay isn't started, so
 * published events stay in the outbox, where the test reads them.
 */
import {
  createDeliveryMemory,
  processDelivery,
  ulid,
  type CloudEvent,
  type DeliveryOutcome,
} from "@asafarim/app-sdk/events";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Types only: lib/db is imported dynamically, after DATABASE_URL points at the throwaway database.
import type * as FlowDb from "../lib/db";
import type * as Workers from "../lib/engine/workers";
import type { AuditEntry } from "../lib/audit";
import { MIGRATIONS } from "../lib/migrations";
import type * as Queries from "../lib/queries";
import { echo, registerEcho } from "./echo-connector";
import { clone, ECHO_FLOW } from "./v2-fixtures";

const ADMIN_URL = process.env.FLOW_TEST_ADMIN_URL ?? process.env.EVENTS_TEST_ADMIN_URL;
const dbName = `flow_test_${Date.now().toString(36)}`;
const NOTE = "docs.note.created.v1";
/** Docs' draft (docs.issue-draft.ready.v1 without runId, stepId, requestId). */
const DRAFT = {
  noteId: "7",
  docPath: "guides/getting-started.md",
  repo: "AliSafari-IT/asafarim-docs",
  public: false,
  title: "Fix the getting-started guide",
  body: "## Context\n\nThe install step is out of date.",
  labels: ["docs"],
};
const DRAFT_PUBLIC = { ...DRAFT, public: true };

const noteEvent = (data: Partial<Record<string, unknown>> = {}): CloudEvent => ({
  specversion: "1.0",
  id: ulid(),
  source: "asafarim://docs",
  type: NOTE,
  time: new Date().toISOString(),
  datacontenttype: "application/json",
  data: {
    id: "7",
    author: "dev-admin",
    docPath: "guides/getting-started.md",
    tags: ["issue"],
    hasIssue: false,
    createdAt: new Date().toISOString(),
    ...data,
  },
});

describe.skipIf(!ADMIN_URL)("flow on Postgres (integration)", () => {
  let admin: pg.Client;
  let flow: typeof FlowDb;
  let workers: typeof Workers;
  let queries: typeof Queries;
  let pool: pg.Pool;
  const memory = createDeliveryMemory();

  /** One delivery the way `subscribe` handles it: inbox row + the engine's transition in one transaction. */
  async function deliver(event: CloudEvent): Promise<DeliveryOutcome> {
    return processDelivery(
      {
        appId: "flow",
        type: event.type,
        handler: async (e, tx) => void (await flow.engine.handle(tx, e)),
        pool,
        memory,
        deadLetter: async () => undefined,
        log: { info: () => undefined, warn: () => undefined },
      },
      {
        data: new TextEncoder().encode(JSON.stringify(event)),
        deliveryCount: 1,
        stream: "APP_DOCS",
        streamSeq: Math.floor(Math.random() * 1e9),
        ack: async () => undefined,
        nak: () => undefined,
        term: () => undefined,
      },
    );
  }
  const q = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
  const runFor = async (eventId: string) =>
    (await q("SELECT * FROM workflow_runs WHERE trigger_event_id = $1", [eventId]))[0];
  const stepsOf = async (runId: string) =>
    q("SELECT * FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq", [runId]);
  const outboxOf = async (runId: string) =>
    q("SELECT id, type, envelope FROM asafarim_outbox WHERE envelope ->> 'subject' = $1 ORDER BY seq", [runId]);

  beforeAll(async () => {
    registerEcho();
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.href;
    flow = await import("../lib/db");
    workers = await import("../lib/engine/workers");
    queries = await import("../lib/queries");
    pool = await flow.db();
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("migrates and seeds once: docs-note-to-issue v1, active; running it again changes nothing", async () => {
    await flow.prepare(pool);
    await flow.prepare(pool);
    const rows = await q(
      "SELECT w.key, w.status, v.version, v.definition FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.id",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "docs-note-to-issue", status: "active", version: 1 });
    expect(rows[0].definition.trigger).toEqual({ event: NOTE });
    expect(await q("SELECT version FROM flow_migrations ORDER BY version")).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version })),
    );
  });

  it("a version can't be changed once published", async () => {
    await expect(pool.query("UPDATE workflow_versions SET definition = '{}'")).rejects.toThrow(/immutable/);
  });

  it("#issue → a run waiting on the draft step, with flow.issue-draft.requested.v1 in the outbox", async () => {
    const event = noteEvent();
    expect(await deliver(event)).toBe("processed");

    const run = await runFor(event.id);
    expect(run).toMatchObject({ status: "waiting", error_code: null, ended_at: null });
    const steps = await stepsOf(run.id);
    expect(steps.map((s) => [s.step_key, s.status])).toEqual([
      ["only-tagged", "succeeded"],
      ["draft", "waiting"],
    ]);
    const draft = steps[1];
    const [row, ...more] = await outboxOf(run.id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ type: "flow.issue-draft.requested.v1", id: draft.request_event_id });
    expect(row.envelope).toMatchObject({
      source: "asafarim://flow",
      type: "flow.issue-draft.requested.v1",
      subject: run.id,
      data: { runId: run.id, stepId: draft.id, noteId: "7", onBehalfOf: "dev-admin" },
    });
    expect(draft.timeout_at.getTime() - draft.started_at.getTime()).toBe(5 * 60_000);
    expect(await q("SELECT event_id FROM asafarim_inbox WHERE event_id = $1", [event.id])).toHaveLength(1);
  });

  it("without the tag → the run is skipped, and nothing is published", async () => {
    const event = noteEvent({ tags: ["idea"] });
    expect(await deliver(event)).toBe("processed");
    const run = await runFor(event.id);
    expect(run.status).toBe("skipped");
    expect(run.ended_at).not.toBeNull();
    expect(await outboxOf(run.id)).toEqual([]);
  });

  it("the same event again creates nothing: the inbox, and trigger_event_id behind it", async () => {
    const event = noteEvent();
    expect(await deliver(event)).toBe("processed");
    const before = Number((await q("SELECT count(*) AS n FROM asafarim_outbox"))[0].n);
    expect(await deliver(event)).toBe("duplicate");
    // Past the inbox (as if its row were gone): the unique trigger_event_id still starts nothing.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await flow.engine.handle(client, event)).toEqual([]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await q("SELECT id FROM workflow_runs WHERE trigger_event_id = $1", [event.id])).toHaveLength(1);
    expect(Number((await q("SELECT count(*) AS n FROM asafarim_outbox"))[0].n)).toBe(before);
  });

  it("a paused workflow starts nothing; resumed, it does again", async () => {
    await flow.inTransaction(pool, (tx) => flow.engine.setWorkflowStatus(tx, "docs-note-to-issue", "paused", "t"));
    const paused = noteEvent();
    await deliver(paused);
    expect(await runFor(paused.id)).toBeUndefined();
    await flow.inTransaction(pool, (tx) => flow.engine.setWorkflowStatus(tx, "docs-note-to-issue", "active", "t"));
    const resumed = noteEvent();
    await deliver(resumed);
    expect((await runFor(resumed.id)).status).toBe("waiting");
  });

  it("the sweeper times out an overdue run, skipping one another connection holds; retry sends a new request", async () => {
    const held = noteEvent();
    const free = noteEvent();
    await deliver(held);
    await deliver(free);
    const heldRun = await runFor(held.id);
    const freeRun = await runFor(free.id);
    // Every waiting step is overdue now (runs from the tests above too).
    await q("UPDATE workflow_run_steps SET timeout_at = now() - interval '1 minute' WHERE status = 'waiting'");

    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE", [heldRun.id]);
      expect(await workers.sweepTimeouts(pool, flow.engine)).toBeGreaterThanOrEqual(1);
      expect((await runFor(held.id)).status).toBe("waiting");
      await other.query("COMMIT");
    } finally {
      other.release();
    }
    expect(await runFor(free.id)).toMatchObject({ status: "failed", error_code: "action_timeout" });
    expect((await stepsOf(freeRun.id))[1]).toMatchObject({ status: "timed_out", error_code: "action_timeout" });
    expect(await workers.sweepTimeouts(pool, flow.engine)).toBe(1); // the one that was held
    expect(await workers.sweepTimeouts(pool, flow.engine)).toBe(0);

    const firstRequest = (await stepsOf(freeRun.id))[1].request_event_id;
    const r = await flow.inTransaction(pool, (tx) => flow.engine.retry(tx, freeRun.id, "dev-admin"));
    expect(r.ok).toBe(true);
    const draft = (await stepsOf(freeRun.id))[1];
    expect(draft).toMatchObject({ status: "waiting", attempts: 2, error_code: null });
    expect(draft.request_event_id).not.toBe(firstRequest);
    expect((await outboxOf(freeRun.id)).map((o) => o.id)).toEqual([firstRequest, draft.request_event_id]);
  });

  it("an outcome moves the run on, in the inbox's transaction; a duplicate answer is ignored", async () => {
    const event = noteEvent();
    await deliver(event);
    const run = await runFor(event.id);
    const draft = (await stepsOf(run.id))[1];
    const ready = (title: string): CloudEvent => ({
      ...noteEvent(),
      id: ulid(),
      type: "docs.issue-draft.ready.v1",
      data: { runId: run.id, stepId: draft.id, ...DRAFT, title },
    });
    expect(await deliver(ready("First"))).toBe("processed");
    expect(await deliver(ready("Second"))).toBe("processed"); // a new event id: past the inbox, ignored by the engine
    const steps = await stepsOf(run.id);
    expect(steps.map((s) => [s.step_key, s.status])).toEqual([
      ["only-tagged", "succeeded"],
      ["draft", "succeeded"],
      ["review", "waiting"],
    ]);
    expect(steps[1].output).toMatchObject({ title: "First" });
    expect(await runFor(event.id)).toMatchObject({ status: "waiting", error_code: null });
    expect(await q("SELECT status, assignee_role FROM approvals WHERE run_id = $1", [run.id])).toEqual([
      { status: "pending", assignee_role: "flow.approver" },
    ]);
  });

  /** A run waiting on its review step: its id, the review step's and the approval's. */
  async function waitingOnReview(draft: Record<string, unknown> = DRAFT) {
    const event = noteEvent();
    await deliver(event);
    const run = await runFor(event.id);
    const step = (await stepsOf(run.id))[1];
    await deliver({
      ...noteEvent(),
      id: ulid(),
      type: "docs.issue-draft.ready.v1",
      data: { runId: run.id, stepId: step.id, requestId: step.request_event_id, ...draft },
    });
    const [approval] = await q("SELECT * FROM approvals WHERE run_id = $1", [run.id]);
    return { runId: run.id as string, approvalId: approval.id as string };
  }

  it("approve with edits: approved, flow.issue.approved.v1 in the outbox in the same transaction", async () => {
    const { runId, approvalId } = await waitingOnReview({ ...DRAFT, public: true });
    const listed = await queries.listPendingApprovals(pool);
    expect(listed.find((a) => a.id === approvalId)).toMatchObject({ runId, docPath: DRAFT.docPath, repo: DRAFT.repo });
    const view = await queries.getApproval(pool, approvalId);
    expect(view).toMatchObject({ draft: DRAFT_PUBLIC, step: { key: "review", editable: ["title", "body", "labels"] } });

    const edits = { title: "Edited title", labels: ["docs", "help wanted"] };
    expect(
      await flow.inTransaction(pool, (tx) => flow.engine.approve(tx, approvalId, "dev-approver", edits, false)),
    ).toMatchObject({ ok: false, error: "public_not_acknowledged" });
    const r = await flow.inTransaction(pool, (tx) => flow.engine.approve(tx, approvalId, "dev-approver", edits, true));
    expect(r.ok).toBe(true);
    const [approval] = await q("SELECT * FROM approvals WHERE id = $1", [approvalId]);
    expect(approval).toMatchObject({ status: "approved", decided_by: "dev-approver", edited: edits });
    const steps = await stepsOf(runId);
    expect(steps.map((s) => [s.step_key, s.status])).toEqual([
      ["only-tagged", "succeeded"],
      ["draft", "succeeded"],
      ["review", "succeeded"],
      ["create", "waiting"],
    ]);
    const out = await outboxOf(runId);
    expect(out.map((o) => o.type)).toEqual(["flow.issue-draft.requested.v1", "flow.issue.approved.v1"]);
    expect(out[1].id).toBe(steps[3].request_event_id);
    expect(out[1].envelope.data).toMatchObject({
      runId,
      stepId: steps[3].id,
      approvalId,
      onBehalfOf: "dev-admin",
      decidedBy: "dev-approver",
      title: "Edited title",
      labels: edits.labels,
      acknowledgedPublic: true,
    });
    // Deciding twice is refused.
    expect(await flow.inTransaction(pool, (tx) => flow.engine.reject(tx, approvalId, "dev-approver"))).toMatchObject({
      ok: false,
      error: "not_pending",
    });
    expect((await queries.getRun(pool, runId))?.approvals).toMatchObject([{ id: approvalId, status: "approved" }]);
  });

  it("reject ends the run rejected; expiry fails it with approval_expired; cancel cancels the approval", async () => {
    const rejected = await waitingOnReview();
    await flow.inTransaction(pool, (tx) => flow.engine.reject(tx, rejected.approvalId, "dev-approver", "No."));
    expect((await q("SELECT status, comment FROM approvals WHERE id = $1", [rejected.approvalId]))[0]).toEqual({
      status: "rejected",
      comment: "No.",
    });
    expect((await q("SELECT status FROM workflow_runs WHERE id = $1", [rejected.runId]))[0].status).toBe("rejected");

    const expiring = await waitingOnReview();
    await q("UPDATE approvals SET deadline = now() - interval '1 minute' WHERE id = $1", [expiring.approvalId]);
    expect(await workers.sweepTimeouts(pool, flow.engine)).toBeGreaterThanOrEqual(1);
    expect((await q("SELECT status FROM approvals WHERE id = $1", [expiring.approvalId]))[0].status).toBe("expired");
    expect((await q("SELECT status, error_code FROM workflow_runs WHERE id = $1", [expiring.runId]))[0]).toEqual({
      status: "failed",
      error_code: "approval_expired",
    });
    expect((await queries.listPendingApprovals(pool)).some((a) => a.id === expiring.approvalId)).toBe(false);

    const cancelled = await waitingOnReview();
    await flow.inTransaction(pool, (tx) => flow.engine.cancel(tx, cancelled.runId, "dev-admin"));
    expect((await q("SELECT status FROM approvals WHERE id = $1", [cancelled.approvalId]))[0].status).toBe("cancelled");
  });

  it("one pending approval per step, in the database too", async () => {
    const { approvalId } = await waitingOnReview();
    await expect(
      q(
        "INSERT INTO approvals (id, run_id, step_id, status, assignee_role) SELECT $2, run_id, step_id, 'pending', 'x' FROM approvals WHERE id = $1",
        [approvalId, ulid()],
      ),
    ).rejects.toThrow(/approvals_one_pending/);
  });

  it("the pages' queries: skipped runs only when asked for; a run with its steps", async () => {
    const all = await queries.listRuns(pool, { skipped: true });
    const shown = await queries.listRuns(pool, { skipped: false });
    expect(all.some((r) => r.status === "skipped")).toBe(true);
    expect(shown.some((r) => r.status === "skipped")).toBe(false);
    const o = await queries.overview(pool);
    expect(o.latest).toHaveLength(Math.min(10, all.length));
    expect(o.waiting.every((r) => r.status === "waiting")).toBe(true);
    expect(o.failures.length).toBeGreaterThanOrEqual(1);
    const one = await queries.getRun(pool, shown[0]!.id);
    expect(one?.definition.key).toBe("docs-note-to-issue");
    expect(one?.steps.length).toBeGreaterThan(0);
    expect(await queries.listWorkflows(pool)).toMatchObject([
      { key: "docs-note-to-issue", status: "active", versions: 1 },
    ]);
  });

  it("retention clears input and output of steps whose run ended over 30 days ago, and keeps the rest", async () => {
    const event = noteEvent({ tags: ["idea"] });
    await deliver(event);
    const run = await runFor(event.id);
    await q("UPDATE workflow_runs SET ended_at = now() - interval '31 days' WHERE id = $1", [run.id]);
    expect(await workers.runRetention(pool)).toBeGreaterThanOrEqual(1);
    const [step] = await stepsOf(run.id);
    expect(step).toMatchObject({ input: null, output: null, status: "succeeded", step_key: "only-tagged" });
    // A recent run keeps its payloads.
    const recent = (
      await q(
        "SELECT s.input FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id WHERE r.ended_at > now() - interval '1 day' LIMIT 1",
      )
    )[0];
    expect(recent.input).not.toBeNull();
  });

  describe("definition v2", () => {
    const tx = <T extends { audits: AuditEntry[] }>(fn: (c: pg.PoolClient) => Promise<T>) =>
      flow.inTransaction<T>(pool, fn);

    it("a draft is saved, refused while invalid, published as a new version; Run now runs manual → condition → test.echo → end", async () => {
      echo.reset();
      const bad = clone(ECHO_FLOW) as unknown as { nodes: Record<string, unknown>[] };
      bad.nodes[1]!.input = { text: "{{steps.done.output}}" };
      const saved = await tx((c) =>
        flow.engine.saveDraft(c, { workflowKey: "echo-flow", name: "Echo", definition: bad, actor: "dev-owner" }),
      );
      expect(saved).toMatchObject({
        ok: true,
        problems: [
          {
            node: "shout",
            path: "input.text",
            message: 'reads "done", which isn\'t upstream of this node on every path',
          },
        ],
      });
      expect(
        await q(
          "SELECT name, draft_updated_by, draft_definition ->> 'key' AS key FROM workflows WHERE key = 'echo-flow'",
        ),
      ).toEqual([{ name: "Echo", draft_updated_by: "dev-owner", key: "echo-flow" }]);
      expect(
        await tx((c) => flow.engine.publishDraft(c, { workflowKey: "echo-flow", actor: "dev-owner" })),
      ).toMatchObject({
        ok: false,
        error: "invalid_definition",
      });
      await tx((c) =>
        flow.engine.saveDraft(c, { workflowKey: "echo-flow", definition: ECHO_FLOW, actor: "dev-owner" }),
      );
      expect(
        await tx((c) => flow.engine.publishDraft(c, { workflowKey: "echo-flow", actor: "dev-owner" })),
      ).toMatchObject({
        ok: true,
        version: 1,
      });
      expect(await q("SELECT draft_definition FROM workflows WHERE key = 'echo-flow'")).toEqual([
        { draft_definition: null },
      ]);
      expect((await queries.listWorkflows(pool)).map((w) => w.key)).toEqual(["docs-note-to-issue", "echo-flow"]);

      const started = await tx((c) =>
        flow.engine.startRun(c, {
          workflowKey: "echo-flow",
          trigger: "manual",
          data: { name: "Ada", loud: true },
          actor: "dev-owner",
        }),
      );
      if (!started.ok) throw new Error(started.error);
      const runId = started.runId;
      expect((await stepsOf(runId)).map((s) => [s.step_key, s.status])).toEqual([
        ["check", "succeeded"],
        ["shout", "pending"],
      ]);
      expect(await workers.runDueConnectors(pool, flow.engine)).toBe(1);
      expect(await workers.runDueConnectors(pool, flow.engine)).toBe(0);
      expect(echo.calls).toEqual([expect.objectContaining({ input: { text: "Hello Ada!" } })]);
      const steps = await stepsOf(runId);
      expect(steps.map((s) => [s.step_key, s.status])).toEqual([
        ["check", "succeeded"],
        ["shout", "succeeded"],
        ["done", "succeeded"],
      ]);
      expect(steps[1]).toMatchObject({
        attempts: 1,
        auto_retries: 0,
        output: { text: "Hello Ada!" },
        timeout_at: null,
      });
      expect(
        (
          await q("SELECT status, test, dry_run, version_id IS NOT NULL AS pinned FROM workflow_runs WHERE id = $1", [
            runId,
          ])
        )[0],
      ).toEqual({
        status: "succeeded",
        test: false,
        dry_run: false,
        pinned: true,
      });
      const one = await queries.getRun(pool, runId);
      expect(one).toMatchObject({
        run: { workflowKey: "echo-flow", version: 1 },
        definition: { version: 2, key: "echo-flow" },
      });
    });

    it("a dry run of the draft carries its definition and calls nothing", async () => {
      echo.reset();
      await tx((c) =>
        flow.engine.saveDraft(c, { workflowKey: "echo-flow", definition: ECHO_FLOW, actor: "dev-owner" }),
      );
      const r = await tx((c) =>
        flow.engine.startDraftRun(c, {
          workflowKey: "echo-flow",
          data: { name: "Bo", loud: true },
          dryRun: true,
          actor: "dev-owner",
        }),
      );
      if (!r.ok) throw new Error(r.error);
      expect(await workers.runDueConnectors(pool, flow.engine)).toBe(0);
      expect(echo.calls).toEqual([]);
      expect((await stepsOf(r.runId))[1]).toMatchObject({
        status: "succeeded",
        output: { text: "(simulated) Hello Bo!" },
      });
      const run = await queries.getRun(pool, r.runId);
      expect(run?.run).toMatchObject({ status: "succeeded", test: true, dryRun: true, version: null, versionId: null });
      expect(run?.definition).toMatchObject({ key: "echo-flow" });
      // Neither a dry run that isn't a test run nor a run with no version and no definition gets in.
      await expect(q("UPDATE workflow_runs SET test = false WHERE id = $1", [r.runId])).rejects.toThrow(
        /workflow_runs_/,
      );
      await expect(q("UPDATE workflow_runs SET draft_definition = NULL WHERE id = $1", [r.runId])).rejects.toThrow(
        /workflow_runs_pinned/,
      );
    });

    it("a crashed call is claimed again once its lease ran out, skipping a run another connection holds", async () => {
      echo.reset();
      const start = () =>
        tx((c) =>
          flow.engine.startRun(c, { workflowKey: "echo-flow", trigger: "manual", data: { name: "Cy", loud: true } }),
        );
      const [a, b] = [await start(), await start()];
      if (!a.ok || !b.ok) throw new Error("not started");
      const ids = [a.runId, b.runId];
      // Both called once by a process that died: running, past their lease.
      await q(
        "UPDATE workflow_run_steps SET status = 'running', attempts = 1, timeout_at = now() - interval '1 second' WHERE run_id = ANY($1) AND step_key = 'shout'",
        [ids],
      );
      const other = await pool.connect();
      try {
        await other.query("BEGIN");
        await other.query("SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE", [ids[0]]);
        expect(await workers.runDueConnectors(pool, flow.engine)).toBe(1);
        expect((await q("SELECT status FROM workflow_runs WHERE id = $1", [ids[0]]))[0].status).toBe("running");
        await other.query("COMMIT");
      } finally {
        other.release();
      }
      expect(await workers.runDueConnectors(pool, flow.engine)).toBe(1);
      for (const id of ids) {
        expect((await stepsOf(id))[1]).toMatchObject({ status: "succeeded", attempts: 2, auto_retries: 1 });
        expect((await q("SELECT status FROM workflow_runs WHERE id = $1", [id]))[0].status).toBe("succeeded");
      }
    });

    it("a wait is resumed by the sweeper", async () => {
      const waiting = {
        ...clone(ECHO_FLOW),
        key: "wait-flow",
        start: "pause",
        nodes: [
          { key: "pause", type: "wait", duration: "PT1H", next: "done" },
          { key: "done", type: "end" },
        ],
      };
      await tx((c) => flow.engine.saveDraft(c, { workflowKey: "wait-flow", definition: waiting, actor: "dev-owner" }));
      await tx((c) => flow.engine.publishDraft(c, { workflowKey: "wait-flow", actor: "dev-owner" }));
      const r = await flow.inTransaction(pool, (c) =>
        flow.engine.startRun(c, { workflowKey: "wait-flow", trigger: "manual", data: { name: "x" } }),
      );
      if (!r.ok) throw new Error(r.error);
      expect((await q("SELECT status FROM workflow_runs WHERE id = $1", [r.runId]))[0].status).toBe("waiting");
      await workers.sweepTimeouts(pool, flow.engine);
      expect((await q("SELECT status FROM workflow_runs WHERE id = $1", [r.runId]))[0].status).toBe("waiting");
      await q("UPDATE workflow_run_steps SET timeout_at = now() - interval '1 second' WHERE run_id = $1", [r.runId]);
      expect(await workers.sweepTimeouts(pool, flow.engine)).toBe(1);
      expect((await q("SELECT status FROM workflow_runs WHERE id = $1", [r.runId]))[0].status).toBe("succeeded");
    });
  });
});
