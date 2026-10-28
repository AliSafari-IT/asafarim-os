/**
 * Webhook in (lib/hooks/): POST /hooks/<id> answers each status in its order (404, 413, 415, 429, 401,
 * then the parse), signatures are compared with timingSafeEqual on equal-length buffers, the generic
 * timestamp window is ±5 minutes, a body over the cap is never read to its end, a redelivery is a
 * duplicate, a paused workflow and `paused_all` start nothing, GitHub deliveries map to the trigger's
 * events and repositories, and the secret is in no log line, answer or page. The route handler runs
 * on the in-memory engine, `webhook → condition → end` (test/flow.integration.test.ts does it on
 * Postgres).
 */
import { ulid } from "@asafarim/app-sdk/events";
import * as crypto from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../lib/engine/engine";
import { publisher } from "../lib/events";
import { BODY_MAX_BYTES, readCapped } from "../lib/hooks/body";
import { curlExample, sampleBody } from "../lib/hooks/example";
import { githubAccepts, githubEventNames, githubTriggerData } from "../lib/hooks/github";
import { createRateLimiter, GLOBAL_RATE_LIMIT } from "../lib/hooks/limiter";
import { receiveHook, type ReceiveDeps } from "../lib/hooks/receive";
import { signGeneric, signGithub, verifyGeneric } from "../lib/hooks/signature";
import type { ReceivingHook } from "../lib/hooks/store";
import { parseDefinition } from "../lib/workflow/definition";
import type { TriggerV2 } from "../lib/workflow/definition-v2";
import manifest from "../platform.app";
import { memoryDb } from "./memory-store";

// The forms' server actions (gated: test/routes.test.ts) aren't called here.
vi.mock("@/app/actions", () => ({ createHookAction: vi.fn(), regenerateHookAction: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const GENERIC_ID = "GenericHookAAAAAAAAAAA";
const GITHUB_ID = "GithubHookBBBBBBBBBBBB";
const OTHER_ID = "OtherHookCCCCCCCCCCCCC";
const SECRET = "hook-SECRET-5e1f0a7b2c9d4e8f6a3b1c0d9e8f7a6b";
const NOW = new Date("2026-10-28T10:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000);

/** webhook → condition → end: a "big" order ends succeeded, any other skipped. */
const GENERIC_FLOW = {
  version: 2,
  key: "order-hook",
  trigger: {
    type: "webhook",
    hook: GENERIC_ID,
    input: [
      { name: "size", type: "string", required: true },
      { name: "amount", type: "number" },
    ],
  },
  start: "check",
  nodes: [
    {
      key: "check",
      type: "condition",
      all: [{ field: "trigger.size", op: "equals", value: "big" }],
      then: "done",
      else: "small",
    },
    { key: "done", type: "end" },
    { key: "small", type: "end", status: "skipped" },
  ],
};
const GITHUB_FLOW = {
  version: 2,
  key: "github-hook",
  trigger: {
    type: "github",
    hook: GITHUB_ID,
    repos: ["AliSafari-IT/asafarim-os"],
    events: ["issues.opened", "pull_request.closed+merged", "push"],
  },
  start: "done",
  nodes: [{ key: "done", type: "end" }],
};

function setup() {
  const mem = memoryDb();
  const logs: string[] = [];
  const log = {
    info: (msg: string, fields?: Record<string, unknown>) => logs.push(JSON.stringify({ msg, ...fields })),
    warn: (msg: string, fields?: Record<string, unknown>) => logs.push(JSON.stringify({ msg, ...fields })),
  };
  const clock = { now: NOW };
  const engine = createEngine({
    store: () => mem.store,
    publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
    newId: () => ulid(),
    now: () => clock.now,
    log,
    manifest,
  });
  for (const d of [GENERIC_FLOW, GITHUB_FLOW]) {
    const r = parseDefinition(d);
    if (!r.ok) throw new Error(r.problems.join("; "));
    mem.publish(r.definition);
  }
  const hooks = new Map<string, ReceivingHook>([
    [GENERIC_ID, { id: GENERIC_ID, workflowKey: "order-hook", kind: "generic", secret: SECRET }],
    [GITHUB_ID, { id: GITHUB_ID, workflowKey: "github-hook", kind: "github", secret: SECRET }],
  ]);
  const touched: string[] = [];
  const found: string[] = [];
  const deps: ReceiveDeps = {
    findHook: async (id) => {
      found.push(id);
      return hooks.get(id);
    },
    start: async (hook, opts) => {
      touched.push(hook.id);
      return engine.startRun(mem.tx, opts);
    },
    touch: async (hook) => void touched.push(hook.id),
    limiter: createRateLimiter(),
    globalLimiter: createRateLimiter(GLOBAL_RATE_LIMIT),
    now: () => clock.now,
    log,
  };
  const answers: string[] = [];
  /** POST to /hooks/<id>; the answer's status, body and headers (kept to search for the secret). */
  async function post(id: string, body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
    const res = await receiveHook(
      new Request(`https://flow.asafarim.site/hooks/${id}`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", ...headers },
        ...(typeof body === "string" ? {} : { duplex: "half" }),
      } as RequestInit),
      id,
      deps,
    );
    const text = await res.text();
    answers.push(text, JSON.stringify([...res.headers]));
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
  }
  const generic = (body: string, headers: Record<string, string> = {}, t = T) =>
    post(GENERIC_ID, body, { "x-flow-signature": signGeneric(SECRET, body, t), ...headers });
  const github = (event: string, payload: object, headers: Record<string, string> = {}) => {
    const body = JSON.stringify(payload);
    return post(GITHUB_ID, body, {
      "x-hub-signature-256": signGithub(SECRET, body),
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      ...headers,
    });
  };
  return { mem, engine, deps, hooks, logs, answers, touched, found, clock, post, generic, github };
}

const BIG = JSON.stringify({ size: "big", amount: 120 });
const REPO = { repository: { full_name: "AliSafari-IT/asafarim-os" } };

beforeEach(() => {
  vi.mocked(crypto.timingSafeEqual).mockClear();
});

describe("POST /hooks/<id>: a signed call", () => {
  it("starts a run: 202 {runId}, the trigger event id from X-Flow-Delivery, last_called_at set", async () => {
    const t = setup();
    const r = await t.generic(BIG, { "x-flow-delivery": "order-42" });
    expect(r.status).toBe(202);
    const run = t.mem.runs.get(r.body.runId as string)!;
    expect(run).toMatchObject({ status: "succeeded", triggerEventId: `hook:${GENERIC_ID}:order-42` });
    expect(run.trigger).toEqual({ size: "big", amount: 120 });
    expect(t.touched).toEqual([GENERIC_ID]);
  });

  it("logs the hook id, the status and the duration: nothing else", async () => {
    const t = setup();
    await t.generic(BIG);
    expect(t.logs.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { msg: "flow.hook.called", hook: GENERIC_ID, status: 202, durationMs: expect.any(Number) },
    ]);
  });
});

describe("rejected before the body is parsed, in order", () => {
  it("an unknown hook: 404 with the body a bad signature gets, after the same read and HMAC", async () => {
    const t = setup();
    const unknown = await t.post(OTHER_ID, BIG, { "x-flow-signature": signGeneric(SECRET, BIG, T) });
    const unknownCompares = vi.mocked(crypto.timingSafeEqual).mock.calls.length;
    vi.mocked(crypto.timingSafeEqual).mockClear();
    const bad = await t.post(GENERIC_ID, BIG, { "x-flow-signature": signGeneric("not the secret", BIG, T) });
    expect(unknown.status).toBe(404);
    expect(bad.status).toBe(401);
    expect(unknown.body).toEqual(bad.body);
    expect(unknownCompares).toBe(1);
    expect(vi.mocked(crypto.timingSafeEqual).mock.calls.length).toBe(1);
  });

  it("an id that isn't shaped like one: 404 without a lookup, logged as invalid", async () => {
    const t = setup();
    expect((await t.post("../../etc/passwd", BIG)).status).toBe(404);
    expect(t.found).toEqual([]);
    expect(t.logs[0]).toContain('"hook":"invalid"');
  });

  it("413 on a Content-Length over 256 KiB, before reading", async () => {
    const t = setup();
    const pulled = { bytes: 0 };
    const r = await t.post(GENERIC_ID, endless(pulled), { "content-length": String(BODY_MAX_BYTES + 1) });
    expect(r.status).toBe(413);
    expect(pulled.bytes).toBe(0);
  });

  it("413 on a body over 256 KiB without a Content-Length: read up to the cap, never to its end", async () => {
    const t = setup();
    const pulled = { bytes: 0 };
    const r = await t.post(GENERIC_ID, endless(pulled));
    expect(r.status).toBe(413);
    expect(pulled.bytes).toBeGreaterThan(BODY_MAX_BYTES);
    expect(pulled.bytes).toBeLessThanOrEqual(BODY_MAX_BYTES + 2 * CHUNK);
  });

  it("readCapped: the bytes up to the cap; past it undefined, the stream cancelled", async () => {
    const pulled = { bytes: 0, cancelled: false };
    expect(await readCapped(endless(pulled), 1000)).toBeUndefined();
    expect(pulled.cancelled).toBe(true);
    expect(Buffer.from((await readCapped(new Response("abc").body, 3))!).toString()).toBe("abc");
    expect(await readCapped(null)).toEqual(new Uint8Array());
  });

  it("415 when the Content-Type isn't JSON (GitHub's form encoding included)", async () => {
    const t = setup();
    const r = await t.generic(BIG, { "content-type": "application/x-www-form-urlencoded" });
    expect(r).toMatchObject({ status: 415, body: { error: "not_json" } });
    expect((await t.generic(BIG, { "content-type": "application/json; charset=utf-8" })).status).toBe(202);
  });

  it("429 past 60 calls a minute per hook, with Retry-After; another hook is counted apart; a minute later, again", async () => {
    const t = setup();
    for (let i = 0; i < 60; i++) expect((await t.generic(BIG, { "x-flow-delivery": `d-${i}` })).status).toBe(202);
    const limited = await t.generic(BIG, { "x-flow-delivery": "d-60" });
    expect(limited).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await t.github("ping", { zen: "z" })).status).toBe(200);
    t.clock.now = new Date(NOW.getTime() + 60_000);
    expect((await t.generic(BIG, { "x-flow-delivery": "d-61" }, T + 60)).status).toBe(202);
  });

  it("429 past 600 calls a minute in all, before the lookup: a flood of unknown ids doesn't reach findHook", async () => {
    const t = setup();
    const randomId = () => crypto.randomBytes(16).toString("base64url");
    for (let i = 0; i < GLOBAL_RATE_LIMIT; i++) expect((await t.post(randomId(), "{}")).status).toBe(404);
    expect(t.found).toHaveLength(GLOBAL_RATE_LIMIT);
    const limited = await t.post(randomId(), "{}");
    expect(limited).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(t.found).toHaveLength(GLOBAL_RATE_LIMIT);
    // A known hook too, until the minute has passed.
    expect((await t.generic(BIG)).status).toBe(429);
    t.clock.now = new Date(NOW.getTime() + 60_000);
    expect((await t.generic(BIG, {}, T + 60)).status).toBe(202);
  });

  it("401 for a missing, malformed or wrong signature, or a changed body; the body is never parsed", async () => {
    const t = setup();
    const parse = vi.spyOn(JSON, "parse");
    const bad = [
      await t.post(GENERIC_ID, BIG),
      await t.post(GENERIC_ID, BIG, { "x-flow-signature": "nonsense" }),
      await t.post(GENERIC_ID, BIG, { "x-flow-signature": `t=${T},v1=abc` }),
      await t.post(GENERIC_ID, BIG, { "x-flow-signature": signGeneric("wrong", BIG, T) }),
      await t.post(GENERIC_ID, BIG.replace("120", "999"), { "x-flow-signature": signGeneric(SECRET, BIG, T) }),
      // A GitHub signature on a generic hook, and the other way round.
      await t.post(GENERIC_ID, BIG, { "x-hub-signature-256": signGithub(SECRET, BIG) }),
      await t.post(GITHUB_ID, BIG, { "x-flow-signature": signGeneric(SECRET, BIG, T), "x-github-event": "push" }),
    ];
    // Only the test's own reads of the answers parse anything.
    const parsedBodies = parse.mock.calls.filter(([text]) => String(text).includes("size"));
    parse.mockRestore();
    expect(bad.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
    for (const r of bad) expect(r.body).toEqual({ error: "rejected" });
    expect(parsedBodies).toEqual([]);
    expect(t.mem.runs.size).toBe(0);
    expect(t.touched).toEqual([]);
  });

  it("then the parse: a signed body that isn't JSON is 415", async () => {
    const t = setup();
    expect(await t.generic("{not json")).toMatchObject({ status: 415, body: { error: "not_json" } });
  });
});

describe("the signature", () => {
  it("is compared with timingSafeEqual on two 32-byte buffers, right or wrong, well-formed or not", async () => {
    const t = setup();
    await t.generic(BIG);
    await t.post(GENERIC_ID, BIG, { "x-flow-signature": signGeneric("wrong", BIG, T) });
    await t.post(GENERIC_ID, BIG, { "x-flow-signature": "t=1,v1=zz" });
    await t.post(GENERIC_ID, BIG);
    await t.github("ping", {});
    const calls = vi.mocked(crypto.timingSafeEqual).mock.calls;
    expect(calls).toHaveLength(5);
    for (const [a, b] of calls) {
      expect(Buffer.isBuffer(a) && Buffer.isBuffer(b)).toBe(true);
      expect([(a as Buffer).length, (b as Buffer).length]).toEqual([32, 32]);
    }
  });

  it("generic: the timestamp may be 5 minutes off either way, not a second more", () => {
    const body = Buffer.from(BIG);
    const at = (offset: number) => verifyGeneric(SECRET, signGeneric(SECRET, BIG, T + offset), body, NOW);
    expect(at(300)).toMatchObject({ ok: true });
    expect(at(-300)).toMatchObject({ ok: true });
    expect(at(301)).toEqual({ ok: false, reason: "stale" });
    expect(at(-301)).toEqual({ ok: false, reason: "stale" });
  });

  it("generic: a stale timestamp is 401 at the route too", async () => {
    const t = setup();
    expect((await t.generic(BIG, {}, T - 301)).status).toBe(401);
    expect((await t.generic(BIG, {}, T + 301)).status).toBe(401);
  });
});

describe("after the signature", () => {
  it("a redelivery is a duplicate: 200 {duplicate:true}, by X-Flow-Delivery, by signature, by X-GitHub-Delivery", async () => {
    const t = setup();
    expect((await t.generic(BIG, { "x-flow-delivery": "same" })).status).toBe(202);
    // A new signature (a later timestamp), the same delivery id.
    expect(await t.generic(BIG, { "x-flow-delivery": "same" }, T + 10)).toMatchObject({
      status: 200,
      body: { duplicate: true },
    });
    // No delivery id: the signature is the id.
    const sig = signGeneric(SECRET, BIG, T);
    expect((await t.post(GENERIC_ID, BIG, { "x-flow-signature": sig })).status).toBe(202);
    expect((await t.post(GENERIC_ID, BIG, { "x-flow-signature": sig })).body).toEqual({ duplicate: true });
    const delivery = { "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" };
    const issue = { action: "opened", ...REPO };
    expect((await t.github("issues", issue, delivery)).status).toBe(202);
    expect(await t.github("issues", issue, delivery)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(t.mem.runs.size).toBe(3);
  });

  it("a paused workflow and Settings paused_all: 202 {started:false}, no run", async () => {
    const t = setup();
    await t.mem.store.setWorkflowStatus("order-hook", "paused");
    expect(await t.generic(BIG)).toMatchObject({ status: 202, body: { started: false } });
    await t.mem.store.setWorkflowStatus("order-hook", "active");
    t.mem.settings.pausedAll = true;
    expect(await t.generic(BIG, { "x-flow-delivery": "x" })).toMatchObject({ status: 202, body: { started: false } });
    expect(await t.github("push", REPO)).toMatchObject({ status: 202, body: { started: false } });
    expect(t.mem.runs.size).toBe(0);
  });

  it("a body that doesn't fit the trigger's input: 422 naming the field, no run", async () => {
    const t = setup();
    expect(await t.generic(JSON.stringify({ amount: 1 }))).toMatchObject({
      status: 422,
      body: { error: "invalid_input", problems: ["size: is required"] },
    });
    expect(t.mem.runs.size).toBe(0);
  });

  it("a published trigger that names another hook: 409, no run", async () => {
    const t = setup();
    t.hooks.set(OTHER_ID, { id: OTHER_ID, workflowKey: "order-hook", kind: "generic", secret: SECRET });
    const r = await t.post(OTHER_ID, BIG, { "x-flow-signature": signGeneric(SECRET, BIG, T) });
    expect(r).toMatchObject({ status: 409, body: { error: "wrong_trigger" } });
  });

  it("a delivery id that isn't one: 400", async () => {
    const t = setup();
    expect((await t.generic(BIG, { "x-flow-delivery": "a b" })).status).toBe(400);
  });
});

describe("GitHub", () => {
  it("answers a ping 200, once it is signed", async () => {
    const t = setup();
    expect(await t.github("ping", { zen: "Design for failure.", hook_id: 1 })).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(t.touched).toEqual([GITHUB_ID]);
    expect((await t.github("ping", {}, { "x-hub-signature-256": signGithub("wrong", "{}") })).status).toBe(401);
  });

  it("maps X-GitHub-Event and the action (and merged) to the trigger's event names", () => {
    expect(githubEventNames("issues", { action: "opened" })).toEqual(["issues", "issues.opened"]);
    expect(githubEventNames("push", {})).toEqual(["push"]);
    expect(githubEventNames("pull_request", { action: "closed", pull_request: { merged: true } })).toEqual([
      "pull_request",
      "pull_request.closed",
      "pull_request.closed+merged",
    ]);
    expect(githubEventNames("pull_request", { action: "closed", pull_request: { merged: false } })).toEqual([
      "pull_request",
      "pull_request.closed",
    ]);
  });

  it("the filter: the events it lists, from the repositories it lists (without case)", () => {
    const trigger = GITHUB_FLOW.trigger as Extract<TriggerV2, { type: "github" }>;
    const take = (event: string, payload: Record<string, unknown>) => githubAccepts(trigger, event, payload);
    expect(take("issues", { action: "opened", ...REPO })).toBe(true);
    expect(take("issues", { action: "labeled", ...REPO })).toBe(false);
    expect(take("push", { repository: { full_name: "alisafari-it/ASAFARIM-OS" } })).toBe(true);
    expect(take("push", { repository: { full_name: "someone/else" } })).toBe(false);
    expect(take("push", {})).toBe(false);
    expect(take("pull_request", { action: "closed", pull_request: { merged: true }, ...REPO })).toBe(true);
    expect(take("pull_request", { action: "closed", pull_request: { merged: false }, ...REPO })).toBe(false);
    expect(take("pull_request", { action: "opened", ...REPO })).toBe(false);
    const any = { ...trigger, events: ["issues"] };
    expect(githubAccepts(any, "issues", { action: "labeled", ...REPO })).toBe(true);
  });

  it('a delivery the trigger doesn\'t take: 202 {started:false, reason:"filtered"}; one it takes: 202 {runId}', async () => {
    const t = setup();
    expect(await t.github("issues", { action: "closed", ...REPO })).toEqual({
      status: 202,
      body: { started: false, reason: "filtered" },
      headers: expect.anything(),
    });
    expect((await t.github("push", { repository: { full_name: "someone/else" } })).body).toMatchObject({
      reason: "filtered",
    });
    const merged = await t.github("pull_request", { action: "closed", pull_request: { merged: true }, ...REPO });
    expect(merged.status).toBe(202);
    expect(t.mem.runs.get(merged.body.runId as string)).toMatchObject({ status: "succeeded" });
  });

  it("a run's trigger data: the payload, with its issue's or pull request's label names as labels", async () => {
    expect(
      githubTriggerData({ action: "opened", issue: { labels: [{ name: "bug" }, { name: "ui" }, { id: 3 }] } }),
    ).toEqual({
      action: "opened",
      issue: { labels: [{ name: "bug" }, { name: "ui" }, { id: 3 }] },
      labels: ["bug", "ui"],
    });
    expect(githubTriggerData({ pull_request: { labels: [{ name: "merged" }] } }).labels).toEqual(["merged"]);
    expect(githubTriggerData({ labels: "not GitHub's" }).labels).toEqual([]);
    const t = setup();
    const merged = await t.github("pull_request", {
      action: "closed",
      pull_request: { merged: true, labels: [{ name: "release" }] },
      ...REPO,
    });
    expect(t.mem.runs.get(merged.body.runId as string)!.trigger).toMatchObject({ labels: ["release"] });
  });

  it("without X-GitHub-Event: 400", async () => {
    const t = setup();
    const body = JSON.stringify(REPO);
    const r = await t.post(GITHUB_ID, body, { "x-hub-signature-256": signGithub(SECRET, body) });
    expect(r).toMatchObject({ status: 400, body: { error: "no_event" } });
  });
});

describe("the secret", () => {
  it("is in no log line and no answer, whatever the call", async () => {
    const t = setup();
    await t.generic(BIG);
    await t.generic("{bad");
    await t.post(GENERIC_ID, BIG, { "x-flow-signature": signGeneric("wrong", BIG, T) });
    await t.post(OTHER_ID, BIG);
    await t.github("ping", {});
    await t.github("issues", { action: "closed", ...REPO });
    t.deps.findHook = async () => {
      throw new Error(`boom ${SECRET}`);
    };
    expect((await t.post(GENERIC_ID, BIG)).status).toBe(500);
    const haystack = [...t.logs, ...t.answers].join("\n");
    expect(haystack).toContain("flow.hook.called");
    expect(haystack.includes(SECRET)).toBe(false);
  });

  it("is in the curl example only when the one-time view fills it in", async () => {
    const { CreateHookForm, RegenerateHookForm } = await import("../components/HookForms");
    const target = { domain: "flow.asafarim.site", body: sampleBody(GENERIC_FLOW.trigger.input as never) };
    const html = renderToStaticMarkup(
      createElement("div", null, [
        createElement(CreateHookForm, { key: "c", workflow: "order-hook", kind: "generic", target }),
        createElement(RegenerateHookForm, { key: "r", hookId: GENERIC_ID, target }),
      ]),
    );
    const placeholder = curlExample({
      url: `https://flow.asafarim.site/hooks/${GENERIC_ID}`,
      kind: "generic",
      body: BIG,
    });
    expect(html).not.toContain(SECRET);
    expect(placeholder).not.toContain(SECRET);
    expect(placeholder).toContain("<the secret shown when it was generated>");
  });
});

describe("the curl example", () => {
  it("signs its test body the way the hook checks it (run with bash and openssl)", async () => {
    const { execFileSync } = await import("node:child_process");
    const body = sampleBody(GENERIC_FLOW.trigger.input as never);
    expect(JSON.parse(body)).toEqual({ size: "test", amount: 1 });
    const tricky = `it's "${SECRET}"`;
    for (const kind of ["generic", "github"] as const) {
      const script = curlExample({ url: `https://flow.asafarim.site/hooks/${GENERIC_ID}`, kind, body, secret: tricky });
      // curl replaced by a function that prints the headers and the body it was given.
      const out = execFileSync("bash", ["-c", `curl() { for a in "$@"; do printf '%s\\n' "$a"; done; }\n${script}`], {
        encoding: "utf8",
      });
      const lines = out.split("\n");
      const sent = lines[lines.indexOf("--data-binary") + 1]!;
      if (kind === "generic") {
        const header = lines.find((l) => l.startsWith("X-Flow-Signature: "))!.slice("X-Flow-Signature: ".length);
        const t = Number(/t=(\d+)/.exec(header)![1]);
        expect(verifyGeneric(tricky, header, Buffer.from(sent), new Date(t * 1000))).toMatchObject({ ok: true });
        expect(sent).toBe(body);
      } else {
        const header = lines.find((l) => l.startsWith("X-Hub-Signature-256: "))!.slice("X-Hub-Signature-256: ".length);
        expect(header).toBe(signGithub(tricky, sent));
        expect(lines).toContain("X-GitHub-Event: ping");
      }
    }
  });
});

describe("the route handler, on the in-memory engine", () => {
  it("a signed generic hook starts a v2 run webhook → condition → end", async () => {
    const t = setup();
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: async () => t.mem.tx,
      engine: t.engine,
      inTransaction: async (_p: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(t.mem.tx),
    }));
    vi.doMock("@/lib/hooks/store", () => ({
      findHook: async (_q: unknown, id: string) => t.hooks.get(id),
      touchHook: async (_q: unknown, id: string) => void t.touched.push(id),
    }));
    try {
      const { POST } = await import("../app/hooks/[id]/route");
      const call = async (body: string, delivery: string) => {
        const res = await POST(
          new Request(`https://flow.asafarim.site/hooks/${GENERIC_ID}`, {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              "x-flow-signature": signGeneric(SECRET, body, Math.floor(Date.now() / 1000)),
              "x-flow-delivery": delivery,
            },
          }),
          { params: Promise.resolve({ id: GENERIC_ID }) },
        );
        return { status: res.status, body: (await res.json()) as { runId: string } };
      };
      const big = await call(BIG, "e2e-1");
      const small = await call(JSON.stringify({ size: "small" }), "e2e-2");
      expect([big.status, small.status]).toEqual([202, 202]);
      expect(t.mem.runs.get(big.body.runId)).toMatchObject({ status: "succeeded" });
      expect(t.mem.runs.get(small.body.runId)).toMatchObject({ status: "skipped" });
      expect(t.mem.steps.filter((s) => s.runId === big.body.runId).map((s) => s.stepKey)).toEqual(["check", "done"]);
      expect(t.touched).toEqual([GENERIC_ID, GENERIC_ID]);
    } finally {
      vi.doUnmock("@/lib/db");
      vi.doUnmock("@/lib/hooks/store");
    }
  });
});

describe("the manifest", () => {
  it("makes /hooks/* public, and no route guards or hides it", () => {
    expect(manifest.auth.publicPaths).toContain("/hooks/*");
    const covers = (pattern: string, path: string) =>
      new RegExp(`^${pattern.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`).test(path);
    for (const r of manifest.routes ?? []) expect(covers(r.path, `/hooks/${GENERIC_ID}`)).toBe(false);
  });
});

const CHUNK = 64 * 1024;
/** A body that never ends, counting what was pulled from it. */
function endless(pulled: { bytes: number; cancelled?: boolean }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled.bytes += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
      cancel() {
        pulled.cancelled = true;
      },
      // Nothing pulled before it is read.
    },
    { highWaterMark: 0 },
  );
}
