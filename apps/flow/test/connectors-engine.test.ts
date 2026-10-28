/**
 * The built-in connectors run by the engine (in-memory store, services faked at the egress and SMTP
 * boundary): the context it gives them, GitHub's duplicate guard across a crash between the create call
 * and the commit (exactly one issue), dry runs (nothing goes out, no secret recorded), placeholders in a
 * webhook's JSON body, and that no secret lands in a step's row or the engine's log.
 */
import { ulid } from "@asafarim/app-sdk/events";
import { beforeEach, describe, expect, it } from "vitest";
import { GITHUB_ISSUE_CREATE } from "../lib/connectors/github";
import { createEngine, LEASE_MARGIN_MS } from "../lib/engine/engine";
import { publisher } from "../lib/events";
import { parseDefinition, type AnyWorkflowDefinition } from "../lib/workflow/definition";
import manifest from "../platform.app";
import { fakeWorld, GITHUB_TOKEN, SMTP_PASSWORD, type World } from "./connector-fakes";
import { memoryDb } from "./memory-store";

const parsed = (value: unknown): AnyWorkflowDefinition => {
  const r = parseDefinition(value);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.definition;
};

/** manual(title) → the given connector nodes in order → end. */
function flow(nodes: { key: string; type: string; input: unknown }[]) {
  return {
    version: 2,
    key: "outbound",
    trigger: { type: "manual", input: [{ name: "title", type: "string", required: true }] },
    start: nodes[0]!.key,
    nodes: [...nodes.map((n, i) => ({ ...n, next: nodes[i + 1]?.key ?? "done" })), { key: "done", type: "end" }],
  };
}

let w: World;
beforeEach(async () => {
  w = await fakeWorld();
  w.mem.settings.set("email_recipients", ["ada@example.com"]);
  w.mem.settings.set("egress_hosts", ["hooks.example.com"]);
});

function setup(definition: unknown) {
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
    services: w.services,
  });
  mem.publish(parsed(definition), "active");
  const start = async (data: Record<string, unknown>, more: { dryRun?: boolean } = {}) => {
    const r = await engine.startRun(mem.tx, {
      workflowKey: "outbound",
      trigger: "manual",
      data,
      actor: "dev-owner",
      ...more,
    });
    if (!r.ok) throw new Error(r.error);
    return r.runId;
  };
  async function work() {
    const claimed = await engine.claimConnector(mem.tx);
    if (!claimed?.claim) return claimed;
    const outcome = await engine.invokeConnector(claimed.claim);
    await engine.completeConnector(mem.tx, claimed.claim, outcome);
    return { ...claimed, outcome };
  }
  const steps = (runId: string) => mem.steps.filter((s) => s.runId === runId);
  return { mem, engine, clock, logs, start, work, steps };
}

describe("the engine calls a built-in connector", () => {
  it("with the run's identity in its context: the marker and the delivery id are made of them", async () => {
    const t = setup(
      flow([
        {
          key: "file",
          type: "github.issue.create",
          input: { credential: w.ids.github, repo: "acme/widgets", title: "{{trigger.title}}" },
        },
        {
          key: "notify",
          type: "webhook.send",
          input: {
            url: "https://hooks.example.com/in",
            credential: w.ids.webhook,
            body: {
              issue: "{{steps.file.output.number}}",
              title: "{{trigger.title}}",
              text: "#{{steps.file.output.number}}: {{trigger.title}}",
              fixed: [1, true, null],
            },
          },
        },
      ]),
    );
    w.onRequest = (req) =>
      req.url.startsWith("https://hooks.example.com/")
        ? { status: 200, headers: {}, body: Buffer.from("") }
        : w.github.handle(req);
    const runId = await t.start({ title: 'Oops "quoted" {{trigger.x}}' });
    await t.work();
    await t.work();
    expect(t.mem.runs.get(runId)!.status).toBe("succeeded");
    const [issue] = w.github.issues("acme/widgets");
    expect(issue!.title).toBe('Oops "quoted" {{trigger.x}}');
    expect(issue!.body).toBe(`<!-- asafarim-flow:${runId}:file -->`);
    const hook = w.requests.find((r) => r.url.startsWith("https://hooks.example.com/"))!;
    expect(hook.headers!["X-Flow-Delivery"]).toBe(`${runId}:notify`);
    // Placeholders filled inside string values only: the body keeps its shape whatever the data holds.
    expect(JSON.parse(String(hook.body))).toEqual({
      issue: "1",
      title: 'Oops "quoted" {{trigger.x}}',
      text: '#1: Oops "quoted" {{trigger.x}}',
      fixed: [1, true, null],
    });
    expect(hook.call).toMatchObject({ connector: "webhook.send", runId });
  });

  it("a placeholder in a webhook body's key, or in a non-templated field, is refused by validation", () => {
    const bad = (input: unknown) => parseDefinition(flow([{ key: "notify", type: "webhook.send", input }]));
    const base = { url: "https://hooks.example.com/in", credential: "c", body: {} };
    expect(bad(base).ok).toBe(true);
    expect(bad({ ...base, body: { a: ["{{trigger.title}}", { b: "{{trigger.title}}" }] } }).ok).toBe(true);
    expect(bad({ ...base, url: "https://hooks.example.com/{{trigger.title}}" }).ok).toBe(false);
    expect(bad({ ...base, credential: "{{trigger.title}}" }).ok).toBe(false);
    expect(bad({ ...base, body: { "{{trigger.title}}": 1 } }).ok).toBe(false);
  });

  it("github.issue.create: a crash between the create call and the commit → claimed again, exactly one issue", async () => {
    const t = setup(
      flow([
        {
          key: "file",
          type: "github.issue.create",
          input: {
            credential: w.ids.github,
            repo: "acme/widgets",
            title: "{{trigger.title}}",
            body: "Body",
            labels: ["bug"],
          },
        },
      ]),
    );
    const runId = await t.start({ title: "Crash test" });
    const first = (await t.engine.claimConnector(t.mem.tx))!.claim!;
    const lost = await t.engine.invokeConnector(first); // the issue is created … and the process dies here
    expect(lost.ok).toBe(true);
    expect(w.github.issues("acme/widgets")).toHaveLength(1);
    t.clock.now = new Date(t.clock.now.getTime() + GITHUB_ISSUE_CREATE.timeoutMs! + LEASE_MARGIN_MS);
    const second = (await t.engine.claimConnector(t.mem.tx))!.claim!;
    expect(second).toMatchObject({ stepId: first.stepId, stepKey: "file", attempt: 2 });
    const outcome = await t.engine.invokeConnector(second);
    await t.engine.completeConnector(t.mem.tx, second, outcome);
    expect(t.mem.runs.get(runId)!.status).toBe("succeeded");
    expect(w.github.issues("acme/widgets")).toHaveLength(1);
    expect(outcome).toEqual(lost);
    expect(t.steps(runId)[0]).toMatchObject({
      status: "succeeded",
      output: { number: 1, url: "https://github.com/acme/widgets/issues/1" },
    });
    expect(w.github.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("github.comment.create: the same across a crash, exactly one comment", async () => {
    w.github.addIssue("acme/widgets", { title: "t", body: "b", creator: "ada" });
    const t = setup(
      flow([
        {
          key: "reply",
          type: "github.comment.create",
          input: { credential: w.ids.github, repo: "acme/widgets", number: 1, body: "On it: {{trigger.title}}" },
        },
      ]),
    );
    const runId = await t.start({ title: "x" });
    await t.engine.invokeConnector((await t.engine.claimConnector(t.mem.tx))!.claim!);
    t.clock.now = new Date(t.clock.now.getTime() + GITHUB_ISSUE_CREATE.timeoutMs! + LEASE_MARGIN_MS);
    await t.work();
    expect(t.mem.runs.get(runId)!.status).toBe("succeeded");
    expect(w.github.issues("acme/widgets")[0]!.comments).toHaveLength(1);
  });

  it("a retryable failure (GitHub 503) is tried again; a credential refusal fails the run at once", async () => {
    const t = setup(
      flow([
        {
          key: "close",
          type: "github.issue.close",
          input: { credential: w.ids.github, repo: "acme/widgets", number: 1 },
        },
      ]),
    );
    w.github.addIssue("acme/widgets", { title: "t", body: "b", creator: "ada" });
    const runId = await t.start({ title: "x" });
    w.github.script.push({ status: 503 });
    await t.work();
    expect(t.steps(runId)[0]).toMatchObject({ status: "pending", errorCode: "github_unavailable" });
    t.clock.now = new Date(t.clock.now.getTime() + 5_000);
    await t.work();
    expect(t.mem.runs.get(runId)!.status).toBe("succeeded");

    const u = setup(
      flow([
        { key: "close", type: "github.issue.close", input: { credential: "missing", repo: "acme/widgets", number: 1 } },
      ]),
    );
    const failed = await u.start({ title: "x" });
    await u.work();
    expect(u.mem.runs.get(failed)).toMatchObject({ status: "failed", errorCode: "credential_not_found" });
  });

  it("dry runs: every connector simulated, nothing goes out, no credential opened, no secret recorded", async () => {
    const t = setup(
      flow([
        {
          key: "mail",
          type: "email.send",
          input: { credential: w.ids.smtp, to: ["ada@example.com"], subject: "{{trigger.title}}", body: "b" },
        },
        {
          key: "file",
          type: "github.issue.create",
          input: { credential: w.ids.github, repo: "acme/widgets", title: "{{trigger.title}}" },
        },
        {
          key: "reply",
          type: "github.comment.create",
          input: { credential: w.ids.github, repo: "acme/widgets", number: "{{steps.file.output.number}}", body: "x" },
        },
        {
          key: "label",
          type: "github.labels.add",
          input: { credential: w.ids.github, repo: "acme/widgets", number: 1, labels: ["bug"] },
        },
        {
          key: "close",
          type: "github.issue.close",
          input: { credential: w.ids.github, repo: "acme/widgets", number: 1 },
        },
        {
          key: "hook",
          type: "webhook.send",
          input: { url: "https://hooks.example.com/in", credential: w.ids.webhook, body: { t: "{{trigger.title}}" } },
        },
      ]),
    );
    const statementsBefore = w.statements.length;
    const runId = await t.start({ title: "Dry" }, { dryRun: true });
    expect(t.mem.runs.get(runId)!.status).toBe("succeeded");
    expect(await t.engine.claimConnector(t.mem.tx)).toBeUndefined();
    expect(w.requests).toEqual([]);
    expect(w.mails).toEqual([]);
    expect(w.statements.slice(statementsBefore)).toEqual([]);
    const steps = t.steps(runId).filter((s) => s.stepKey !== "done");
    expect(steps.map((s) => s.stepKey)).toEqual(["mail", "file", "reply", "label", "close", "hook"]);
    for (const s of steps)
      expect(s).toMatchObject({ status: "succeeded", output: expect.objectContaining({ simulated: true }) });
    // What would be sent is recorded, with the credential's id only.
    expect(steps[0]!.input).toEqual({ credential: w.ids.smtp, to: ["ada@example.com"], subject: "Dry", body: "b" });
    expect(steps[2]!.input).toMatchObject({ number: "0" });
    const recorded = JSON.stringify([steps, t.logs]);
    for (const s of [SMTP_PASSWORD, GITHUB_TOKEN, w.webhookSecret]) expect(recorded).not.toContain(s);
  });

  it("no secret in a step's row or the engine's log, after real calls that succeed and fail", async () => {
    const t = setup(
      flow([
        {
          key: "mail",
          type: "email.send",
          input: { credential: w.ids.smtp, to: ["ada@example.com"], subject: "s", body: "b" },
        },
        {
          key: "file",
          type: "github.issue.create",
          input: { credential: w.ids.github, repo: "acme/widgets", title: "t" },
        },
        {
          key: "hook",
          type: "webhook.send",
          input: { url: "https://hooks.example.com/in", credential: w.ids.webhook, body: {} },
        },
      ]),
    );
    w.onRequest = (req) =>
      req.url.startsWith("https://hooks.example.com/")
        ? { status: 500, headers: {}, body: Buffer.from("") }
        : w.github.handle(req);
    const runId = await t.start({ title: "x" });
    for (let i = 0; i < 6; i++) {
      await t.work();
      t.clock.now = new Date(t.clock.now.getTime() + 130_000);
    }
    expect(t.mem.runs.get(runId)).toMatchObject({ status: "failed", errorCode: "http_500" });
    const recorded = JSON.stringify([t.steps(runId), t.logs]);
    for (const s of [SMTP_PASSWORD, GITHUB_TOKEN, w.webhookSecret]) expect(recorded).not.toContain(s);
  });
});
