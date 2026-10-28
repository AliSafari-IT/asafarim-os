/**
 * The built-in connectors (lib/connectors), each against the real credential store and Settings, with
 * SMTP and GitHub faked and egress stubbed at its boundary (connector-fakes.ts): every success and
 * failure code, the recipient and host allow-lists, email's rate limits, GitHub's duplicate guard, the
 * webhook's signature, and that no secret reaches an output, a log line or an error.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_CONNECTORS } from "../lib/connectors";
import { EMAIL_LIMIT_PER_WORKFLOW, EMAIL_LIMIT_TOTAL, EMAIL_SEND } from "../lib/connectors/email";
import {
  GITHUB_COMMENT_CREATE,
  GITHUB_ISSUE_CLOSE,
  GITHUB_ISSUE_CREATE,
  GITHUB_LABELS_ADD,
  markerOf,
} from "../lib/connectors/github";
import { WEBHOOK_SEND } from "../lib/connectors/webhook";
import { signatureHeader, verifySignature } from "../lib/connectors/webhook-signature";
import { ConnectorError, connectors, type Connector, type ConnectorContext } from "../lib/engine/connectors";
import { EgressError } from "../lib/egress/egress";
import { SmtpEgressError } from "../lib/egress/smtp";
import { contextFor, fakeWorld, GITHUB_TOKEN, SMTP_PASSWORD, SMTP_USER, type World } from "./connector-fakes";

let w: World;
beforeEach(async () => {
  w = await fakeWorld();
  w.mem.settings.set("email_recipients", ["ada@example.com", "@team.example"]);
  w.mem.settings.set("egress_hosts", ["hooks.example.com", "alt.example.com:8443"]);
});

/** What `run` threw, as { code, retryable, message }. */
async function failure<I, O>(connector: Connector<I, O>, ctx: ConnectorContext, input: unknown) {
  try {
    await connector.run(ctx, connector.input.parse(input));
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    return { code: err.code, retryable: err.retryable, message: err.message };
  }
  throw new Error("expected the call to fail");
}
const codeOf = async <I, O>(connector: Connector<I, O>, ctx: ConnectorContext, input: unknown) =>
  (await failure(connector, ctx, input)).code;
const run = <I, O>(connector: Connector<I, O>, ctx: ConnectorContext, input: unknown) =>
  connector.run(ctx, connector.input.parse(input));

describe("the production registry", () => {
  it("has the six connectors, each with schemas and a simulate", () => {
    const types = BUILTIN_CONNECTORS.map((c) => c.type);
    expect(types).toEqual([
      "email.send",
      "github.issue.create",
      "github.comment.create",
      "github.labels.add",
      "github.issue.close",
      "webhook.send",
    ]);
    for (const t of types) expect(connectors.get(t)).toBeDefined();
  });
});

describe("the context", () => {
  it("credentials: a missing or invalid FLOW_CREDENTIALS_KEY is credentials_unavailable, not retryable", async () => {
    for (const env of [{}, { FLOW_CREDENTIALS_KEY: "not-a-key" }]) {
      const world = await fakeWorld({ env });
      world.mem.settings.set("email_recipients", ["ada@example.com"]);
      const { ctx } = contextFor(world);
      const input = { credential: world.ids.smtp, to: ["ada@example.com"], subject: "s", body: "b" };
      expect(await failure(EMAIL_SEND, ctx, input)).toMatchObject({
        code: "credentials_unavailable",
        retryable: false,
      });
      expect(world.mails).toEqual([]);
    }
  });

  it("credentials: unknown id and wrong kind are refused, not retryable", async () => {
    const { ctx } = contextFor(w);
    expect(
      await failure(EMAIL_SEND, ctx, { credential: "nope", to: ["ada@example.com"], subject: "s", body: "b" }),
    ).toMatchObject({ code: "credential_not_found", retryable: false });
    expect(
      await codeOf(EMAIL_SEND, ctx, { credential: w.ids.github, to: ["ada@example.com"], subject: "s", body: "b" }),
    ).toBe("credential_kind_mismatch");
  });

  it("egress calls are recorded against the run, the step and the connector", async () => {
    const { ctx } = contextFor(w, { runId: "r9", stepId: "s9", connector: "github.issue.close" });
    await run(GITHUB_ISSUE_CLOSE, ctx, { credential: w.ids.github, repo: "acme/widgets", number: 1 }).catch(() => 0);
    expect(w.requests[0]!.call).toEqual({ connector: "github.issue.close", runId: "r9", stepId: "s9" });
  });
});

describe("email.send", () => {
  const input = (more: Record<string, unknown> = {}) => ({
    credential: w.ids.smtp,
    to: ["Ada@Example.com", "bob@team.example"],
    subject: "Weekly report",
    body: "Hello\nthere",
    ...more,
  });

  it("sends through the credential's server and answers the message id", async () => {
    const { ctx } = contextFor(w);
    expect(await run(EMAIL_SEND, ctx, input())).toEqual({ messageId: "queued-1" });
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0]).toMatchObject({
      server: { host: "smtp.example.com", port: 587, mode: "starttls", username: SMTP_USER, password: SMTP_PASSWORD },
      message: { from: "flow@example.com", to: ["ada@example.com", "bob@team.example"], subject: "Weekly report" },
    });
    w.onMail = async () => ({});
    expect(await run(EMAIL_SEND, contextFor(w, { stepId: "s2" }).ctx, input())).toEqual({ messageId: null });
  });

  it("a recipient off the list (or not an address) is recipient_not_allowed, before anything is opened", async () => {
    for (const to of [["eve@evil.example"], ["ada@example.com", "x@sub.team.example"], ["not an address"]]) {
      const { ctx } = contextFor(w);
      expect(await failure(EMAIL_SEND, ctx, input({ to }))).toMatchObject({
        code: "recipient_not_allowed",
        retryable: false,
      });
    }
    expect(w.mails).toEqual([]);
    expect(w.statements.some((s) => s.includes("FROM credentials"))).toBe(false);
  });

  it("an empty list allows no one", async () => {
    w.mem.settings.set("email_recipients", []);
    expect(await codeOf(EMAIL_SEND, contextFor(w).ctx, input())).toBe("recipient_not_allowed");
  });

  it("at most 10 recipients; the subject at most 200, the body 50,000 (schema); a line break in the subject refused", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@team.example`);
    expect(EMAIL_SEND.input.safeParse(input({ to: eleven })).success).toBe(false);
    expect(EMAIL_SEND.input.safeParse(input({ subject: "x".repeat(201) })).success).toBe(false);
    expect(EMAIL_SEND.input.safeParse(input({ body: "x".repeat(50_001) })).success).toBe(false);
    expect(await codeOf(EMAIL_SEND, contextFor(w).ctx, input({ subject: "Hi\r\nBcc: eve@evil.example" }))).toBe(
      "invalid_request",
    );
    expect(w.mails).toEqual([]);
  });

  it("rate limits: 100 a day per workflow, 500 in all; a step called again keeps its place", async () => {
    for (let i = 0; i < EMAIL_LIMIT_PER_WORKFLOW; i++)
      await run(EMAIL_SEND, contextFor(w, { stepId: `a${i}`, workflowId: "wf-a" }).ctx, input());
    expect(
      await failure(EMAIL_SEND, contextFor(w, { stepId: "a-over", workflowId: "wf-a" }).ctx, input()),
    ).toMatchObject({ code: "rate_limited", retryable: false });
    // The same step again (a retry, or after a crash) isn't counted twice.
    await run(EMAIL_SEND, contextFor(w, { stepId: "a0", workflowId: "wf-a" }).ctx, input());
    expect(w.sends).toHaveLength(EMAIL_LIMIT_PER_WORKFLOW);
    // Another workflow still may, up to the total.
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < EMAIL_LIMIT_PER_WORKFLOW; j++)
        await run(EMAIL_SEND, contextFor(w, { stepId: `b${i}-${j}`, workflowId: `wf-b${i}` }).ctx, input());
    expect(w.sends).toHaveLength(EMAIL_LIMIT_TOTAL);
    expect(await codeOf(EMAIL_SEND, contextFor(w, { stepId: "c", workflowId: "wf-c" }).ctx, input())).toBe(
      "rate_limited",
    );
    // A day later the places are free again.
    for (const s of w.sends) s.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(await run(EMAIL_SEND, contextFor(w, { stepId: "d", workflowId: "wf-a" }).ctx, input())).toEqual({
      messageId: "queued-1",
    });
  });

  it("a send that fails gives its place back", async () => {
    w.onMail = async () => {
      throw new SmtpEgressError("smtp_unavailable", "smtp.example.com");
    };
    await codeOf(EMAIL_SEND, contextFor(w).ctx, input());
    expect(w.sends).toEqual([]);
  });

  it("each SMTP failure as its code: smtp_auth, smtp_unavailable (retryable), and the address checks", async () => {
    const cases: [SmtpEgressError["code"], boolean][] = [
      ["smtp_auth", false],
      ["smtp_unavailable", true],
      ["dns_failed", true],
      ["smtp_rejected", false],
      ["smtp_tls", false],
      ["private_address", false],
      ["insecure_refused", false],
      ["paused_all", false],
      ["invalid_message", false],
    ];
    for (const [code, retryable] of cases) {
      w.onMail = async () => {
        throw new SmtpEgressError(code, "smtp.example.com");
      };
      expect(await failure(EMAIL_SEND, contextFor(w, { stepId: code }).ctx, input())).toMatchObject({
        code,
        retryable,
      });
    }
  });

  it("simulate: no message id, marked simulated", () => {
    expect(EMAIL_SEND.output.parse(EMAIL_SEND.simulate(EMAIL_SEND.input.parse(input())))).toEqual({
      messageId: null,
      simulated: true,
    });
  });
});

describe("GitHub", () => {
  const create = (more: Record<string, unknown> = {}) => ({
    credential: w.ids.github,
    repo: "acme/widgets",
    title: "Broken",
    body: "It broke.",
    labels: ["bug"],
    ...more,
  });

  it("github.issue.create: number and url; the body carries the step's marker; labels as given", async () => {
    const { ctx } = contextFor(w, { runId: "run-7", stepKey: "file" });
    expect(await run(GITHUB_ISSUE_CREATE, ctx, create({ labels: ["bug", "needs triage"] }))).toEqual({
      number: 1,
      url: "https://github.com/acme/widgets/issues/1",
    });
    const [issue] = w.github.issues("acme/widgets");
    expect(issue).toMatchObject({ title: "Broken", labels: ["bug", "needs triage"] });
    expect(issue!.body).toBe("It broke.\n\n<!-- asafarim-flow:run-7:file -->");
    expect(w.requests.every((r) => r.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(w.requests.every((r) => r.allow.length === 1 && r.allow[0]!.host === "api.github.com")).toBe(true);
  });

  it("duplicate guard: called again for the same step, the issue it created is the answer", async () => {
    const first = await run(GITHUB_ISSUE_CREATE, contextFor(w).ctx, create());
    const again = await run(GITHUB_ISSUE_CREATE, contextFor(w).ctx, create());
    expect(again).toEqual(first);
    expect(w.github.issues("acme/widgets")).toHaveLength(1);
    // Another step (or run) creates its own.
    await run(GITHUB_ISSUE_CREATE, contextFor(w, { stepKey: "other" }).ctx, create());
    expect(w.github.issues("acme/widgets")).toHaveLength(2);
  });

  it("duplicate guard: someone else's issue, or a pull request, with the marker doesn't count", async () => {
    const marker = markerOf({ runId: "run-1", stepKey: "act" });
    w.github.addIssue("acme/widgets", { title: "copy", body: marker, creator: "mallory" });
    w.github.addIssue("acme/widgets", { title: "pr", body: marker, creator: "flow-bot", pullRequest: true });
    expect((await run(GITHUB_ISSUE_CREATE, contextFor(w).ctx, create())).number).toBe(3);
  });

  it("github.comment.create: id and url, guarded the same way (the token's own comments only)", async () => {
    w.github.addIssue("acme/widgets", { title: "t", body: "b", creator: "ada" });
    w.github.addComment("acme/widgets", 1, { body: markerOf({ runId: "run-1", stepKey: "act" }), login: "mallory" });
    const input = { credential: w.ids.github, repo: "acme/widgets", number: "1", body: "Thanks" };
    const first = await run(GITHUB_COMMENT_CREATE, contextFor(w).ctx, input);
    expect(first).toEqual({ id: expect.any(Number), url: expect.stringContaining("/issues/1#issuecomment-") });
    expect(await run(GITHUB_COMMENT_CREATE, contextFor(w).ctx, input)).toEqual(first);
    const comments = w.github.issues("acme/widgets")[0]!.comments.filter((c) => c.user.login === "flow-bot");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe("Thanks\n\n<!-- asafarim-flow:run-1:act -->");
  });

  it("github.labels.add and github.issue.close", async () => {
    w.github.addIssue("acme/widgets", { title: "t", body: "b", creator: "ada" });
    const base = { credential: w.ids.github, repo: "acme/widgets", number: 1 };
    expect(await run(GITHUB_LABELS_ADD, contextFor(w).ctx, { ...base, labels: ["bug"] })).toEqual({ labels: ["bug"] });
    expect(await run(GITHUB_ISSUE_CLOSE, contextFor(w).ctx, { ...base, reason: "not_planned" })).toEqual({
      state: "closed",
    });
    expect(w.github.issues("acme/widgets")[0]).toMatchObject({ state: "closed", stateReason: "not_planned" });
    expect(GITHUB_ISSUE_CLOSE.input.parse(base).reason).toBe("completed");
    expect(GITHUB_ISSUE_CLOSE.input.safeParse({ ...base, reason: "duplicate" }).success).toBe(false);
  });

  it("a repository the credential doesn't list is repo_not_allowed, before any call", async () => {
    expect(await failure(GITHUB_ISSUE_CREATE, contextFor(w).ctx, create({ repo: "acme/other" }))).toMatchObject({
      code: "repo_not_allowed",
      retryable: false,
    });
    expect(w.requests).toEqual([]);
  });

  it("a label the repository doesn't have is label_not_found; nothing is created", async () => {
    expect(await codeOf(GITHUB_ISSUE_CREATE, contextFor(w).ctx, create({ labels: ["bug", "wontfix"] }))).toBe(
      "label_not_found",
    );
    w.github.addIssue("acme/widgets", { title: "t", body: "b", creator: "ada" });
    const add = { credential: w.ids.github, repo: "acme/widgets", number: 1, labels: ["nope"] };
    expect(await codeOf(GITHUB_LABELS_ADD, contextFor(w).ctx, add)).toBe("label_not_found");
    expect(w.github.issues("acme/widgets")).toHaveLength(1);
    // Names compare case-insensitively, as GitHub does.
    expect(await run(GITHUB_ISSUE_CREATE, contextFor(w).ctx, create({ labels: ["BUG"] }))).toMatchObject({ number: 2 });
  });

  it("GitHub's answers: 401/403/404 no_repo_access, 422 invalid_request, 5xx and timeouts github_unavailable (retryable)", async () => {
    const cases: [{ status: number; headers?: Record<string, string> } | EgressError, string, boolean][] = [
      [{ status: 401 }, "no_repo_access", false],
      [{ status: 403 }, "no_repo_access", false],
      [{ status: 404 }, "no_repo_access", false],
      [{ status: 422 }, "invalid_request", false],
      [{ status: 500 }, "github_unavailable", true],
      [{ status: 503 }, "github_unavailable", true],
      [{ status: 429 }, "github_unavailable", true],
      [{ status: 403, headers: { "x-ratelimit-remaining": "0" } }, "github_unavailable", true],
      [new EgressError("timeout", "api.github.com"), "github_unavailable", true],
      [new EgressError("connect_failed", "api.github.com"), "github_unavailable", true],
      [new EgressError("paused_all", "api.github.com"), "paused_all", false],
      [new EgressError("address_refused", "api.github.com"), "private_address", false],
    ];
    const close = { credential: w.ids.github, repo: "acme/widgets", number: 1 };
    for (const [answer, code, retryable] of cases) {
      w.github.script.push(answer);
      expect({
        answer: String(answer),
        ...(await failure(GITHUB_ISSUE_CLOSE, contextFor(w).ctx, close)),
      }).toMatchObject({
        code,
        retryable,
      });
    }
    // An issue that doesn't exist, or a token that no longer works.
    expect(await codeOf(GITHUB_ISSUE_CLOSE, contextFor(w).ctx, { ...close, number: 99 })).toBe("no_repo_access");
  });

  it("an issue number from a placeholder must be a number", async () => {
    const bad = { credential: w.ids.github, repo: "acme/widgets", number: "12abc" };
    expect(await codeOf(GITHUB_ISSUE_CLOSE, contextFor(w).ctx, bad)).toBe("invalid_request");
    expect(await codeOf(GITHUB_ISSUE_CLOSE, contextFor(w).ctx, { ...bad, number: "0" })).toBe("invalid_request");
  });

  it("limits: title 256, body 60,000 (schema); an empty title refused", async () => {
    expect(GITHUB_ISSUE_CREATE.input.safeParse(create({ title: "x".repeat(257) })).success).toBe(false);
    expect(GITHUB_ISSUE_CREATE.input.safeParse(create({ body: "x".repeat(60_001) })).success).toBe(false);
    expect(GITHUB_ISSUE_CREATE.input.safeParse(create({ repo: "not a repo" })).success).toBe(false);
    expect(await codeOf(GITHUB_ISSUE_CREATE, contextFor(w).ctx, create({ title: "  " }))).toBe("invalid_request");
  });
});

describe("webhook.send", () => {
  const input = (more: Record<string, unknown> = {}) => ({
    url: "https://hooks.example.com/flow",
    credential: w.ids.webhook,
    body: { event: "note", data: { title: "Hi", n: 2, ok: true, tags: ["a"], none: null } },
    ...more,
  });
  const ok = () => ({ status: 202, headers: {}, body: Buffer.from("") });

  it("POSTs the JSON body, signed; the delivery id is the run and the step", async () => {
    w.onRequest = ok;
    const before = Math.floor(Date.now() / 1000);
    expect(await run(WEBHOOK_SEND, contextFor(w, { runId: "run-3", stepKey: "notify" }).ctx, input())).toEqual({
      status: 202,
    });
    const req = w.requests[0]!;
    expect(req).toMatchObject({ method: "POST", url: "https://hooks.example.com/flow" });
    expect(req.allow).toEqual([{ host: "hooks.example.com" }, { host: "alt.example.com", ports: [8443] }]);
    const body = String(req.body);
    expect(JSON.parse(body)).toEqual(input().body);
    const headers = req.headers!;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Flow-Delivery"]).toBe("run-3:notify");
    const sig = headers["X-Flow-Signature"]!;
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const t = Number(/^t=(\d+)/.exec(sig)![1]);
    expect(t).toBeGreaterThanOrEqual(before);
    // The receiver's check (the scheme inbound webhooks use): the secret, the raw body, the time.
    expect(verifySignature(w.webhookSecret, sig, body, t)).toBe(true);
    expect(verifySignature(w.webhookSecret, sig, body.replace("Hi", "Ho"), t)).toBe(false);
    expect(verifySignature("another-secret", sig, body, t)).toBe(false);
    expect(verifySignature(w.webhookSecret, sig, body, t + 301)).toBe(false);
    expect(verifySignature(w.webhookSecret, undefined, body, t)).toBe(false);
    expect(signatureHeader(w.webhookSecret, body, t)).toBe(sig);
    // Called again for the same step: the same delivery id.
    await run(WEBHOOK_SEND, contextFor(w, { runId: "run-3", stepKey: "notify" }).ctx, input());
    expect(w.requests[1]!.headers!["X-Flow-Delivery"]).toBe("run-3:notify");
  });

  it("the host must be on Settings egress_hosts (egress refuses it: host_not_allowed)", async () => {
    w.onRequest = () => {
      throw new EgressError("host_not_allowed", "evil.example");
    };
    expect(await failure(WEBHOOK_SEND, contextFor(w).ctx, input({ url: "https://evil.example/x" }))).toMatchObject({
      code: "host_not_allowed",
      retryable: false,
    });
    w.mem.settings.set("egress_hosts", []);
    w.onRequest = ok;
    await run(WEBHOOK_SEND, contextFor(w).ctx, input());
    expect(w.requests.at(-1)!.allow).toEqual([]);
  });

  it("errors: private_address, timeout (retryable), http_<status> (5xx retryable)", async () => {
    const cases: [() => never | ReturnType<typeof ok>, string, boolean][] = [
      [
        () => {
          throw new EgressError("address_refused", "hooks.example.com");
        },
        "private_address",
        false,
      ],
      [
        () => {
          throw new EgressError("timeout", "hooks.example.com");
        },
        "timeout",
        true,
      ],
      [
        () => {
          throw new EgressError("connect_failed", "hooks.example.com");
        },
        "connect_failed",
        true,
      ],
      [
        () => {
          throw new EgressError("redirect_refused", "hooks.example.com", 302);
        },
        "http_302",
        false,
      ],
      [
        () => {
          throw new EgressError("request_too_large", "hooks.example.com");
        },
        "request_too_large",
        false,
      ],
      [() => ({ status: 500, headers: {}, body: Buffer.from("") }), "http_500", true],
      [() => ({ status: 503, headers: {}, body: Buffer.from("") }), "http_503", true],
      [() => ({ status: 429, headers: {}, body: Buffer.from("") }), "http_429", true],
      [() => ({ status: 400, headers: {}, body: Buffer.from("") }), "http_400", false],
      [() => ({ status: 404, headers: {}, body: Buffer.from("") }), "http_404", false],
    ];
    for (const [answer, code, retryable] of cases) {
      w.onRequest = answer;
      expect(await failure(WEBHOOK_SEND, contextFor(w).ctx, input())).toMatchObject({ code, retryable });
    }
  });

  it("the URL is https:// only (schema); a key of the body can't carry a placeholder", () => {
    expect(WEBHOOK_SEND.input.safeParse(input({ url: "http://hooks.example.com/x" })).success).toBe(false);
    expect(WEBHOOK_SEND.input.safeParse(input({ body: { "{{trigger.x}}": 1 } })).success).toBe(false);
    expect(WEBHOOK_SEND.input.safeParse(input({ body: [1, "two", [false], { a: null }] })).success).toBe(true);
  });
});

describe("secrets", () => {
  it("never in an output, a log line or an error, whatever the outcome", async () => {
    const secrets = [SMTP_PASSWORD, SMTP_USER, GITHUB_TOKEN, w.webhookSecret];
    const seen: unknown[] = [];
    const attempt = async <I, O>(connector: Connector<I, O>, input: unknown) => {
      const { ctx, logs } = contextFor(w, { stepId: `s${seen.length}` });
      try {
        seen.push(await run(connector, ctx, input));
      } catch (err) {
        seen.push({ code: (err as ConnectorError).code, message: (err as Error).message, stack: (err as Error).stack });
      }
      seen.push(logs);
    };
    const gh = { credential: w.ids.github, repo: "acme/widgets" };
    const answers = [
      () => ({ status: 200, headers: {}, body: Buffer.from("[]") }),
      () => ({ status: 401, headers: {}, body: Buffer.from(`{"message":"Bad credentials ${"x"}"}`) }),
      () => {
        throw new EgressError("timeout", "api.github.com");
      },
    ];
    for (const answer of [undefined, ...answers]) {
      w.onRequest = answer ?? ((req) => w.github.handle(req));
      await attempt(GITHUB_ISSUE_CREATE, { ...gh, title: "t", body: "b" });
      await attempt(GITHUB_COMMENT_CREATE, { ...gh, number: 1, body: "b" });
      await attempt(GITHUB_LABELS_ADD, { ...gh, number: 1, labels: ["bug"] });
      await attempt(GITHUB_ISSUE_CLOSE, { ...gh, number: 1 });
      await attempt(WEBHOOK_SEND, { url: "https://hooks.example.com/x", credential: w.ids.webhook, body: {} });
    }
    w.mem.settings.set("email_recipients", ["ada@example.com"]);
    for (const mail of [
      async () => ({ messageId: "id" }),
      async () => {
        throw new SmtpEgressError("smtp_auth", "smtp.example.com");
      },
    ]) {
      w.onMail = mail;
      await attempt(EMAIL_SEND, { credential: w.ids.smtp, to: ["ada@example.com"], subject: "s", body: "b" });
    }
    const text = JSON.stringify(seen);
    expect(seen.length).toBeGreaterThan(20);
    for (const s of secrets) expect(text).not.toContain(s);
  });
});
