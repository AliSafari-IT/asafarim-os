/**
 * Docs answers `flow.issue-draft.requested.v1` (Flow PR 4a): every branch of the handler, run the
 * way the subscriber runs it (the SDK's `processDelivery`: the inbox row and the handler in one
 * transaction over test/fake-db.ts). GitHub and the AI are mocked as in test/issue.test.ts; nothing
 * is ever created on GitHub, and every answer validates against its schema and carries the request's
 * event id.
 */
import path from "node:path";
import { AccessUnavailableError } from "@asafarim/app-sdk";
import {
  compileEventSchema,
  createDeliveryMemory,
  processDelivery,
  sourceFor,
  type DeliveryOutcome,
} from "@asafarim/app-sdk/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import failedSchema from "../events/docs.issue-draft.failed.v1.json";
import readySchema from "../events/docs.issue-draft.ready.v1.json";
import { ISSUE_DRAFT_FAILED, ISSUE_DRAFT_READY } from "../lib/events";
import {
  AiNoIssueError,
  AiTimeoutError,
  AiUnavailableError,
  GitHubUnavailableError,
  NoRepoAccessError,
  type IssueTracker,
  type IssueWriter,
} from "../lib/issue-clients";
import { createIssueDraftHandler, ISSUE_DRAFT_REQUESTED } from "../lib/issue-draft-handler";
import { createNotesStore, type NotesStore } from "../lib/notes";
import { createFixtureBackend, createSource } from "../lib/source";
import { fakeDb, type FakeDb } from "./fake-db";

const who = vi.hoisted(() => ({ permissions: [] as string[], outage: false, asked: [] as string[] }));
const services = vi.hoisted(() => ({
  tracker: null as IssueTracker | null,
  writer: null as IssueWriter | null,
}));

vi.mock("@/lib/platform", () => ({
  getPlatform: () => ({
    config: {
      getString: (k: string) =>
        k === "source.repo" ? "example-org/handbook" : k === "ai.model" ? "claude-test" : "main",
    },
    access: {
      subjectHas: async (subject: string, permission: string) => {
        who.asked.push(`${subject}:${permission}`);
        if (who.outage) throw new AccessUnavailableError("core-api is unreachable");
        return who.permissions.includes(permission);
      },
    },
  }),
}));
const fixtures = createSource(createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures")));
vi.mock("@/lib/source", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSource: () => fixtures,
}));
vi.mock("@/lib/issue-clients", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getIssueTracker: () => services.tracker,
  getIssueWriter: () => services.writer,
}));

const ROADMAP = "ventures/demo-app/roadmap/roadmap.md";
const NOTE_BODY = "Link it to a milestone. A private thought.";
const GOOD_BODY = [
  "## Context",
  "The demo app tracks its beta.",
  "## Problem / request",
  "Ship the beta.",
  "## Suggested steps",
  "1. Do it.",
  "## Done when",
  "- [ ] The beta is out.",
].join("\n");

function fakeTracker(opts: { public?: boolean; fail?: Error } = {}) {
  const calls: string[] = [];
  const tracker: IssueTracker = {
    async repo(repo) {
      calls.push(`repo ${repo}`);
      if (opts.fail) throw opts.fail;
      return { public: opts.public ?? false };
    },
    async labels(repo) {
      calls.push(`labels ${repo}`);
      if (opts.fail) throw opts.fail;
      return ["bug", "enhancement", "docs"];
    },
    async create(repo) {
      calls.push(`create ${repo}`);
      throw new Error("never creates an issue");
    },
    async findByMarker(repo) {
      calls.push(`findByMarker ${repo}`);
      throw new Error("never looks for an issue");
    },
  };
  return { tracker, calls };
}

function fakeWriter(answer: unknown, fail?: Error) {
  const prompts: { system: string; user: string }[] = [];
  const writer: IssueWriter = {
    async draft(prompt) {
      prompts.push(prompt);
      if (fail) throw fail;
      return { answer, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  return { writer, prompts };
}

const validateReady = compileEventSchema(readySchema);
const validateFailed = compileEventSchema(failedSchema);

let db: FakeDb;
let store: NotesStore;
let noteId: string;
let gh: ReturnType<typeof fakeTracker>;
let ai: ReturnType<typeof fakeWriter>;
let seq: number;
beforeEach(async () => {
  who.permissions = ["docs.read", "docs.issues.create"];
  who.outage = false;
  who.asked = [];
  db = fakeDb();
  store = createNotesStore(db.pool);
  noteId = (
    await store.create("owner", {
      docPath: ROADMAP,
      headingId: "tracking",
      quote: "The beta is tracked",
      body: NOTE_BODY,
      docSha: "0".repeat(64),
    })
  ).id;
  gh = fakeTracker();
  ai = fakeWriter({ title: "Ship the beta", body: GOOD_BODY, labels: ["Enhancement", "nope"] });
  services.tracker = gh.tracker;
  services.writer = ai.writer;
  seq = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const request = (data: Record<string, unknown> = {}) => ({
  runId: "run-1",
  stepId: "step-1",
  noteId,
  onBehalfOf: "owner",
  ...data,
});

/** Deliver one request event the way the subscriber does; the answers it wrote and how it ended. */
async function deliver(data: unknown, id = "01JREQUEST000000000000000A") {
  const envelope = {
    specversion: "1.0",
    id,
    source: sourceFor("flow"),
    type: ISSUE_DRAFT_REQUESTED,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data,
  };
  const acks: string[] = [];
  const outcome: DeliveryOutcome = await processDelivery(
    {
      appId: "docs",
      type: ISSUE_DRAFT_REQUESTED,
      handler: createIssueDraftHandler(),
      pool: db.pool,
      memory: createDeliveryMemory(),
      backoff: { initialMs: 1, maxMs: 1 },
      deadLetter: async () => undefined,
    },
    {
      data: new TextEncoder().encode(JSON.stringify(envelope)),
      deliveryCount: 1,
      stream: "APP_FLOW",
      streamSeq: ++seq,
      ack: async () => void acks.push("ack"),
      nak: () => void acks.push("nak"),
      term: () => void acks.push("term"),
    },
  );
  return { outcome, acks, answers: answers() };
}

/** The answers in the outbox (not the note's own docs.note.created.v1), each checked against its schema. */
function answers() {
  return db.outbox
    .filter((r) => r.type === ISSUE_DRAFT_READY || r.type === ISSUE_DRAFT_FAILED)
    .map((r) => {
      const validate = r.type === ISSUE_DRAFT_READY ? validateReady : validateFailed;
      expect(validate(r.envelope.data), JSON.stringify(validate.errors)).toBe(true);
      expect(r.envelope.subject).toBe(r.envelope.data.noteId);
      return { type: r.type, data: r.envelope.data };
    });
}

async function expectFailure(code: string, data: unknown = request()) {
  const { outcome, acks, answers } = await deliver(data);
  expect(outcome).toBe("processed");
  expect(acks).toEqual(["ack"]);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    type: ISSUE_DRAFT_FAILED,
    data: { runId: "run-1", stepId: "step-1", requestId: "01JREQUEST000000000000000A", code },
  });
  const message = String(answers[0]!.data.message);
  expect(message).not.toContain(NOTE_BODY);
  expect(message).not.toMatch(/\n\s+at /);
  expect(gh.calls.some((c) => c.startsWith("create"))).toBe(false);
  return answers[0]!.data;
}

describe("flow.issue-draft.requested.v1: a draft", () => {
  it("publishes docs.issue-draft.ready.v1 for the repo that owns the document, and creates nothing on GitHub", async () => {
    const { outcome, acks, answers } = await deliver(request());
    expect(outcome).toBe("processed");
    expect(acks).toEqual(["ack"]);
    expect(answers).toEqual([
      {
        type: ISSUE_DRAFT_READY,
        data: {
          runId: "run-1",
          stepId: "step-1",
          requestId: "01JREQUEST000000000000000A",
          noteId,
          docPath: ROADMAP,
          repo: "example-org/demo-app",
          public: false,
          title: "Ship the beta",
          body: GOOD_BODY,
          // Only labels the repo has, spelled as it spells them.
          labels: ["enhancement"],
        },
      },
    ]);
    expect(gh.calls).toEqual(["repo example-org/demo-app", "labels example-org/demo-app"]);
    // The same context as the HTTP route: the note, its section, the repo's labels.
    expect(ai.prompts[0]!.user).toContain("Section: Setup › Tracking");
    expect(ai.prompts[0]!.user).toContain("Existing labels in example-org/demo-app: bug, enhancement, docs");
    expect(db.inbox).toEqual(["01JREQUEST000000000000000A"]);
    // Both permissions are asked for the subject the run acts for.
    expect(who.asked.sort()).toEqual(["owner:docs.issues.create", "owner:docs.read"]);
  });

  it("carries the repo's visibility, and the prompt warns about a public repo", async () => {
    services.tracker = fakeTracker({ public: true }).tracker;
    const { answers } = await deliver(request());
    expect(answers[0]!.data.public).toBe(true);
    expect(ai.prompts[0]!.system).toContain("PUBLIC");
  });

  it("replaces links to the reader with the document's path", async () => {
    services.writer = fakeWriter({
      title: "Ship it",
      body: `${GOOD_BODY}\nSee https://docs.asafarim.site/?doc=x.md#y.`,
      labels: [],
    }).writer;
    const { answers } = await deliver(request());
    expect(answers[0]!.data.body).toContain(`See ${ROADMAP}`);
    expect(answers[0]!.data.body).not.toContain("docs.asafarim.site");
  });

  it("requestId is always the id of the request event answered", async () => {
    const { answers } = await deliver(request(), "01JOTHERREQUEST00000000000");
    expect(answers[0]!.data.requestId).toBe("01JOTHERREQUEST00000000000");
  });

  it("a redelivered request is handled once: one answer, one AI call", async () => {
    expect((await deliver(request())).outcome).toBe("processed");
    const again = await deliver(request());
    expect(again.outcome).toBe("duplicate");
    expect(again.acks).toEqual(["ack"]);
    expect(again.answers).toHaveLength(1);
    expect(ai.prompts).toHaveLength(1);
  });

  it("a new attempt (another request id) for the same step is answered again, with its own id", async () => {
    await deliver(request(), "01JATTEMPT1000000000000000");
    const { answers } = await deliver(request(), "01JATTEMPT2000000000000000");
    expect(answers.map((a) => a.data.requestId)).toEqual(["01JATTEMPT1000000000000000", "01JATTEMPT2000000000000000"]);
  });
});

describe("flow.issue-draft.requested.v1: what it refuses", () => {
  it("an invalid payload is logged and acked, never retried and never answered", async () => {
    for (const data of [
      { runId: "run-1", stepId: "step-1", noteId },
      { ...request(), extra: true },
      { ...request(), runId: "" },
      "not an object",
    ]) {
      const { outcome, acks, answers } = await deliver(data, `01JINVALID${String(seq).padStart(16, "0")}`);
      expect(outcome).toBe("processed");
      expect(acks).toEqual(["ack"]);
      expect(answers).toEqual([]);
    }
    expect(ai.prompts).toEqual([]);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.filter((l) => l.includes("issue.draft_request_invalid"))).toHaveLength(4);
  });

  it("a missing note is note_not_found", async () => {
    await expectFailure("note_not_found", request({ noteId: "999" }));
  });

  it("another author's note is note_not_found, the same answer: it's never revealed", async () => {
    const data = await expectFailure("note_not_found", request({ onBehalfOf: "someone-else" }));
    expect(data.message).toBe("No such note.");
    expect(who.asked).toEqual([]);
    expect(ai.prompts).toEqual([]);
  });

  it("a note id that isn't one is note_not_found, not a database error", async () => {
    await expectFailure("note_not_found", request({ noteId: "abc" }));
  });

  it("without docs.issues.create, or without docs.read: forbidden", async () => {
    who.permissions = ["docs.read"];
    expect((await expectFailure("forbidden")).message).toContain("docs.issues.create");
    db.outbox.length = 0;
    db.inbox.length = 0;
    who.permissions = ["docs.issues.create"];
    expect((await expectFailure("forbidden")).message).toContain("docs.read");
    expect(ai.prompts).toEqual([]);
  });

  it("a permission check that can't be made is thrown: redelivered, nothing answered or recorded", async () => {
    who.outage = true;
    const { outcome, acks, answers } = await deliver(request());
    expect(outcome).toBe("retry");
    expect(acks).toEqual(["nak"]);
    expect(answers).toEqual([]);
    expect(db.inbox).toEqual([]);
    expect(ai.prompts).toEqual([]);
    // Once core-api answers again, the redelivery is handled.
    who.outage = false;
    expect((await deliver(request())).answers).toMatchObject([{ type: ISSUE_DRAFT_READY }]);
  });

  it("a note that already has an issue is issue_exists", async () => {
    await store.setIssueUrl("owner", noteId, "https://github.com/example-org/demo-app/issues/7");
    await expectFailure("issue_exists");
    expect(ai.prompts).toEqual([]);
  });
});

describe("flow.issue-draft.requested.v1: outside failures", () => {
  it("GitHub's 401/403/404 for the repo is no_repo_access", async () => {
    gh = fakeTracker({ fail: new NoRepoAccessError("example-org/demo-app") });
    services.tracker = gh.tracker;
    expect((await expectFailure("no_repo_access")).message).toBe("No access to example-org/demo-app");
  });

  it("an AI answer that fails validation is invalid_ai_answer", async () => {
    services.writer = fakeWriter({ title: "x", body: "no sections" }).writer;
    await expectFailure("invalid_ai_answer");
  });

  it("an AI answer without the issue tool call is invalid_ai_answer", async () => {
    services.writer = fakeWriter(undefined, new AiNoIssueError()).writer;
    await expectFailure("invalid_ai_answer");
  });

  it("a draft that the link rewrite makes longer than the event allows is invalid_ai_answer", async () => {
    const title = "//docs.asafarim.site ".repeat(9).trim();
    expect(title.length).toBeLessThanOrEqual(200);
    services.writer = fakeWriter({ title, body: GOOD_BODY, labels: [] }).writer;
    await expectFailure("invalid_ai_answer");
  });

  it.each([
    ["a timeout", new AiTimeoutError()],
    ["a network error", new AiUnavailableError("the request failed")],
    ["a 5xx", new AiUnavailableError("HTTP 503", 503)],
    ["a 429", new AiUnavailableError("HTTP 429", 429)],
  ])("%s from the AI is ai_unavailable", async (_what, err) => {
    services.writer = fakeWriter(undefined, err).writer;
    await expectFailure("ai_unavailable");
  });

  it.each([
    [
      "the AI's 400 (a configuration error)",
      () => (services.writer = fakeWriter(undefined, new AiUnavailableError("HTTP 400", 400)).writer),
    ],
    ["GitHub's 5xx", () => (services.tracker = fakeTracker({ fail: new GitHubUnavailableError("HTTP 502") }).tracker)],
    ["an unexpected error", () => (services.writer = fakeWriter(undefined, new Error("boom")).writer)],
    // Not set up: the contract has no answer for it, so Flow's step keeps waiting.
    ["no DOCS_ISSUES_TOKEN", () => (services.tracker = null)],
    ["no DOCS_AI_API_KEY", () => (services.writer = null)],
  ])("%s is thrown: redelivered, nothing answered", async (_what, arrange) => {
    arrange();
    const { outcome, acks, answers } = await deliver(request());
    expect(outcome).toBe("retry");
    expect(acks).toEqual(["nak"]);
    expect(answers).toEqual([]);
    expect(db.inbox).toEqual([]);
  });
});
