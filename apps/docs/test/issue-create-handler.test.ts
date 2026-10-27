/**
 * Docs answers `flow.issue.approved.v1` (Flow PR 5): every branch of the handler, run the way the
 * subscriber runs it (the SDK's `processDelivery`: the inbox row and the handler in one transaction
 * over test/fake-db.ts), against a fake GitHub that keeps the issues it created. Every answer
 * validates against its schema and carries the request's event id. Then acceptance criterion 6: GitHub
 * creates the issue, the handler crashes before its transaction commits, the event is redelivered, and
 * exactly one issue exists, its URL saved on the note.
 */
import { AccessUnavailableError } from "@asafarim/app-sdk";
import {
  compileEventSchema,
  createDeliveryMemory,
  processDelivery,
  sourceFor,
  type DeliveryOutcome,
} from "@asafarim/app-sdk/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import createdSchema from "../events/docs.issue.created.v1.json";
import failedSchema from "../events/docs.issue.failed.v1.json";
import { ISSUE_CREATED, ISSUE_FAILED } from "../lib/events";
import {
  createGitHubIssues,
  GitHubUnavailableError,
  loopbackUrl,
  NoRepoAccessError,
  type IssueTracker,
} from "../lib/issue-clients";
import {
  approvalMarker,
  createIssueCreateHandler,
  defaultIssueCreateDeps,
  ISSUE_APPROVED,
} from "../lib/issue-create-handler";
import { createNotesStore, issueViaFlow, type NotesStore } from "../lib/notes";
import { fakeDb, type FakeDb } from "./fake-db";

const who = vi.hoisted(() => ({ permissions: [] as string[], outage: false, asked: [] as string[] }));
const services = vi.hoisted(() => ({ tracker: null as IssueTracker | null }));

vi.mock("@/lib/platform", () => ({
  getPlatform: () => ({
    config: { getString: () => "" },
    access: {
      subjectHas: async (subject: string, permission: string) => {
        who.asked.push(`${subject}:${permission}`);
        if (who.outage) throw new AccessUnavailableError("core-api is unreachable");
        return who.permissions.includes(permission);
      },
    },
  }),
}));
vi.mock("@/lib/issue-clients", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getIssueTracker: () => services.tracker,
}));

const REPO = "example-org/demo-app";
const NOTE_BODY = "Link it to a milestone. A private thought. #issue";
const BODY = "## Context\nThe demo app tracks its beta.\n## Done when\n- [ ] The beta is out.";

interface Issue {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
}

/** GitHub as far as creating an issue goes: it keeps what it created, and `log` is shared with the database's writes. */
function fakeGitHub(log: string[], opts: { public?: boolean; fail?: Partial<Record<keyof IssueTracker, Error>> } = {}) {
  const issues: Issue[] = [];
  const looked: { repo: string; marker: string; since: Date }[] = [];
  const tracker: IssueTracker = {
    async repo(repo) {
      log.push(`github repo ${repo}`);
      if (opts.fail?.repo) throw opts.fail.repo;
      return { public: opts.public ?? false };
    },
    async labels(repo) {
      log.push(`github labels ${repo}`);
      if (opts.fail?.labels) throw opts.fail.labels;
      return ["bug", "enhancement", "docs"];
    },
    async create(repo, issue) {
      log.push(`github create ${repo}`);
      if (opts.fail?.create) throw opts.fail.create;
      const number = issues.length + 1;
      const created = { repo, number, url: `https://github.com/${repo}/issues/${number}`, ...issue };
      issues.push(created);
      return { url: created.url, number };
    },
    async findByMarker(repo, marker, since) {
      log.push(`github find ${repo}`);
      if (opts.fail?.findByMarker) throw opts.fail.findByMarker;
      looked.push({ repo, marker, since });
      const hit = issues.find((i) => i.repo === repo && i.body.includes(marker));
      return hit ? { url: hit.url, number: hit.number } : null;
    },
  };
  return { tracker, issues, looked };
}

const validateCreated = compileEventSchema(createdSchema);
const validateFailed = compileEventSchema(failedSchema);

let db: FakeDb;
let store: NotesStore;
let noteId: string;
let log: string[];
let gh: ReturnType<typeof fakeGitHub>;
let seq: number;
beforeEach(async () => {
  who.permissions = ["docs.read", "docs.issues.create"];
  who.outage = false;
  who.asked = [];
  db = fakeDb();
  store = createNotesStore(db.pool);
  noteId = (
    await store.create("owner", {
      docPath: "ventures/demo-app/roadmap/roadmap.md",
      headingId: "tracking",
      quote: "The beta is tracked",
      body: NOTE_BODY,
      docSha: "0".repeat(64),
    })
  ).id;
  log = [];
  gh = fakeGitHub(log);
  services.tracker = gh.tracker;
  seq = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const approved = (data: Record<string, unknown> = {}) => ({
  runId: "run-1",
  stepId: "step-create",
  approvalId: "appr-1",
  noteId,
  onBehalfOf: "owner",
  decidedBy: "owner",
  decidedAt: "2026-10-27T12:00:00.000Z",
  repo: REPO,
  title: "Ship the beta",
  body: BODY,
  labels: ["Enhancement"],
  acknowledgedPublic: false,
  ...data,
});

/** The handler as the subscriber builds it, with the approval recorded through the test's store (committed on its own). */
const handler = () =>
  createIssueCreateHandler({
    ...defaultIssueCreateDeps(),
    recordApproval: async (author, id, approvalId) => {
      log.push("db record approval");
      return store.recordFlowApproval(author, id, approvalId);
    },
  });

/** Deliver one request event the way the subscriber does; the answers it wrote and how it ended. */
async function deliver(data: unknown, id = "01JAPPROVED00000000000000A") {
  const envelope = {
    specversion: "1.0",
    id,
    source: sourceFor("flow"),
    type: ISSUE_APPROVED,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data,
  };
  const acks: string[] = [];
  const outcome: DeliveryOutcome = await processDelivery(
    {
      appId: "docs",
      type: ISSUE_APPROVED,
      handler: handler(),
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
    .filter((r) => r.type === ISSUE_CREATED || r.type === ISSUE_FAILED)
    .map((r) => {
      const validate = r.type === ISSUE_CREATED ? validateCreated : validateFailed;
      expect(validate(r.envelope.data), JSON.stringify(validate.errors)).toBe(true);
      expect(r.envelope.subject).toBe(r.envelope.data.noteId);
      return { type: r.type, data: r.envelope.data };
    });
}

const savedNote = async () => (await store.get("owner", noteId))!;

async function expectFailure(code: string, data: unknown = approved()) {
  const { outcome, acks, answers } = await deliver(data);
  expect(outcome).toBe("processed");
  expect(acks).toEqual(["ack"]);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    type: ISSUE_FAILED,
    data: { runId: "run-1", stepId: "step-create", requestId: "01JAPPROVED00000000000000A", code },
  });
  const message = String(answers[0]!.data.message);
  expect(message).not.toContain(NOTE_BODY);
  expect(message).not.toMatch(/\n\s+at /);
  expect(gh.issues).toEqual([]);
  return answers[0]!.data;
}

describe("flow.issue.approved.v1: the issue is created", () => {
  it("creates the approved issue, saves its URL on the note and publishes docs.issue.created.v1", async () => {
    const { outcome, acks, answers } = await deliver(approved());
    expect(outcome).toBe("processed");
    expect(acks).toEqual(["ack"]);
    expect(answers).toEqual([
      {
        type: ISSUE_CREATED,
        data: {
          runId: "run-1",
          stepId: "step-create",
          requestId: "01JAPPROVED00000000000000A",
          noteId,
          issueUrl: `https://github.com/${REPO}/issues/1`,
        },
      },
    ]);
    // Exactly the approved issue, labels spelled as the repo spells them, the body ending with the hidden marker.
    expect(gh.issues).toEqual([
      {
        repo: REPO,
        number: 1,
        url: `https://github.com/${REPO}/issues/1`,
        title: "Ship the beta",
        body: `${BODY}\n\n<!-- asafarim-flow:appr-1 -->`,
        labels: ["enhancement"],
      },
    ]);
    const note = await savedNote();
    expect(note.issueUrl).toBe(`https://github.com/${REPO}/issues/1`);
    expect(note.flowApprovalId).toBe("appr-1");
    expect(issueViaFlow(note)).toBe(true);
    // Visibility asked now, then the approval recorded (committed on its own) before GitHub creates anything.
    expect(log).toEqual([
      `github repo ${REPO}`,
      `github labels ${REPO}`,
      "db record approval",
      `github create ${REPO}`,
    ]);
    expect(gh.looked).toEqual([]);
    expect(who.asked.sort()).toEqual(["owner:docs.issues.create", "owner:docs.read"]);
    expect(db.inbox).toEqual(["01JAPPROVED00000000000000A"]);
  });

  it("the approval is recorded outside the inbox transaction, the URL inside it", async () => {
    await deliver(approved());
    const sqls = db.statements.map((s) => s.sql);
    const begin = sqls.lastIndexOf("BEGIN");
    const record = sqls.findIndex((s) => s.includes("flow_approval_id = $3"));
    const save = sqls.findIndex((s) => /^UPDATE notes SET issue_url = \$3, updated_at/.test(s));
    // Through the pool (autocommit), though the inbox transaction is open.
    expect(record).toBeGreaterThan(begin);
    expect(db.statements[record]!.params).toEqual(["owner", noteId, "appr-1"]);
    expect(save).toBeGreaterThan(record);
    expect(sqls.indexOf("COMMIT", save)).toBeGreaterThan(save);
  });

  it("a public repo with acknowledgedPublic: true is created", async () => {
    gh = fakeGitHub(log, { public: true });
    services.tracker = gh.tracker;
    const { answers } = await deliver(approved({ acknowledgedPublic: true }));
    expect(answers).toMatchObject([{ type: ISSUE_CREATED }]);
    expect(gh.issues).toHaveLength(1);
  });

  it("requestId is always the id of the request event answered", async () => {
    const { answers } = await deliver(approved(), "01JOTHERREQUEST00000000000");
    expect(answers[0]!.data.requestId).toBe("01JOTHERREQUEST00000000000");
  });

  it("a duplicate delivery changes nothing: one answer, one issue", async () => {
    expect((await deliver(approved())).outcome).toBe("processed");
    const before = structuredClone(db.notes);
    const again = await deliver(approved());
    expect(again.outcome).toBe("duplicate");
    expect(again.acks).toEqual(["ack"]);
    expect(again.answers).toHaveLength(1);
    expect(gh.issues).toHaveLength(1);
    expect(db.notes).toEqual(before);
  });

  it("an issue created through the note's own page isn't shown as via Flow", async () => {
    await store.recordFlowApproval("owner", noteId, "appr-0");
    const note = await store.setIssueUrl("owner", noteId, `https://github.com/${REPO}/issues/9`);
    expect(note?.flowApprovalId).toBeNull();
    expect(issueViaFlow(note!)).toBe(false);
  });
});

describe("flow.issue.approved.v1: what it refuses", () => {
  it("an invalid payload is logged and acked, never retried and never answered", async () => {
    const { approvalId: _a, ...withoutApproval } = approved();
    for (const data of [
      withoutApproval,
      { ...approved(), extra: true },
      { ...approved(), runId: "" },
      { ...approved(), repo: "not a repo" },
      { ...approved(), labels: ["bug", "bug"] },
      { ...approved(), decidedAt: "yesterday" },
      "not an object",
    ]) {
      const { outcome, acks, answers } = await deliver(data, `01JINVALID${String(seq).padStart(16, "0")}`);
      expect(outcome).toBe("processed");
      expect(acks).toEqual(["ack"]);
      expect(answers).toEqual([]);
    }
    expect(log).toEqual([]);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.filter((l) => l.includes("issue.create_request_invalid"))).toHaveLength(7);
  });

  it("a missing note, another author's note, or an id that isn't one: note_not_found", async () => {
    await expectFailure("note_not_found", approved({ noteId: "999" }));
    db.outbox.length = 0;
    db.inbox.length = 0;
    const data = await expectFailure("note_not_found", approved({ onBehalfOf: "someone-else" }));
    expect(data.message).toBe("No such note.");
    expect(who.asked).toEqual([]);
    db.outbox.length = 0;
    db.inbox.length = 0;
    await expectFailure("note_not_found", approved({ noteId: "abc" }));
    expect(log).toEqual([]);
  });

  it("without docs.issues.create, or without docs.read: forbidden", async () => {
    who.permissions = ["docs.read"];
    expect((await expectFailure("forbidden")).message).toContain("docs.issues.create");
    db.outbox.length = 0;
    db.inbox.length = 0;
    who.permissions = ["docs.issues.create"];
    expect((await expectFailure("forbidden")).message).toContain("docs.read");
    expect(log).toEqual([]);
  });

  it("a permission check that can't be made is thrown: redelivered, nothing answered or recorded", async () => {
    who.outage = true;
    const { outcome, acks, answers } = await deliver(approved());
    expect(outcome).toBe("retry");
    expect(acks).toEqual(["nak"]);
    expect(answers).toEqual([]);
    expect(db.inbox).toEqual([]);
    expect(log).toEqual([]);
    who.outage = false;
    expect((await deliver(approved())).answers).toMatchObject([{ type: ISSUE_CREATED }]);
  });

  it("a note that already has an issue is issue_exists: Flow never confirms a second one", async () => {
    await store.setIssueUrl("owner", noteId, `https://github.com/${REPO}/issues/7`);
    await expectFailure("issue_exists");
    expect(log).toEqual([]);
  });

  it("a repo that is public now, without acknowledgedPublic: public_not_acknowledged, nothing recorded", async () => {
    gh = fakeGitHub(log, { public: true });
    services.tracker = gh.tracker;
    const data = await expectFailure("public_not_acknowledged");
    expect(data.message).toContain(`${REPO} is public`);
    expect((await savedNote()).flowApprovalId).toBeNull();
  });

  it("labels the repo doesn't have: invalid_issue, naming them", async () => {
    const data = await expectFailure("invalid_issue", approved({ labels: ["bug", "made-up", "nope"] }));
    expect(data.message).toBe(`${REPO} has no label "made-up", "nope".`);
    expect((await savedNote()).flowApprovalId).toBeNull();
  });

  it("a link to the reader: invalid_issue, saying so, without asking GitHub", async () => {
    const data = await expectFailure(
      "invalid_issue",
      approved({ body: `${BODY}\nSee https://docs.asafarim.site/?doc=x.md.` }),
    );
    expect(data.message).toContain("docs.asafarim.site");
    expect(log).toEqual([]);
  });
});

describe("flow.issue.approved.v1: GitHub's failures", () => {
  it("GitHub's 401/403/404 is no_repo_access", async () => {
    gh = fakeGitHub(log, { fail: { repo: new NoRepoAccessError(REPO) } });
    services.tracker = gh.tracker;
    expect((await expectFailure("no_repo_access")).message).toBe(`No access to ${REPO}`);
  });

  it.each([
    ["a 5xx", new GitHubUnavailableError("HTTP 502")],
    ["a timeout", new GitHubUnavailableError("timed out")],
  ])("%s is github_unavailable", async (_what, err) => {
    gh = fakeGitHub(log, { fail: { create: err } });
    services.tracker = gh.tracker;
    expect((await expectFailure("github_unavailable")).message).toBe("GitHub isn't answering.");
  });

  it.each([
    [
      "an unexpected error",
      () => (services.tracker = fakeGitHub(log, { fail: { create: new Error("boom") } }).tracker),
    ],
    ["no DOCS_ISSUES_TOKEN", () => (services.tracker = null)],
  ])("%s is thrown: redelivered, nothing answered", async (_what, arrange) => {
    arrange();
    const { outcome, acks, answers } = await deliver(approved());
    expect(outcome).toBe("retry");
    expect(acks).toEqual(["nak"]);
    expect(answers).toEqual([]);
    expect(db.inbox).toEqual([]);
  });
});

describe("no duplicate issue after a crash (acceptance criterion 6)", () => {
  it.each([
    ["writing the answer", (sql: string) => sql.startsWith("INSERT INTO asafarim_outbox")],
    ["saving the URL", (sql: string) => sql.startsWith("UPDATE notes SET issue_url")],
    ["the commit", (sql: string) => sql === "COMMIT"],
  ])(
    "GitHub created the issue, the handler crashed at %s: the redelivery reuses it, one issue, URL saved",
    async (_at, failOn) => {
      db.failOn = failOn;
      const first = await deliver(approved());
      expect(first.outcome).toBe("retry");
      expect(first.answers).toEqual([]);
      expect(db.inbox).toEqual([]);
      // GitHub has the issue; the note has the approval (committed on its own) but no URL.
      expect(gh.issues).toHaveLength(1);
      const crashed = await savedNote();
      expect(crashed.flowApprovalId).toBe("appr-1");
      expect(crashed.issueUrl).toBeNull();

      const again = await deliver(approved());
      expect(again.outcome).toBe("processed");
      expect(gh.issues).toHaveLength(1);
      expect(again.answers).toEqual([
        {
          type: ISSUE_CREATED,
          data: expect.objectContaining({ issueUrl: `https://github.com/${REPO}/issues/1` }),
        },
      ]);
      expect((await savedNote()).issueUrl).toBe(`https://github.com/${REPO}/issues/1`);
      // Looked for the marker, since (a little before) the approval was recorded, before creating anything.
      expect(gh.looked).toEqual([{ repo: REPO, marker: approvalMarker("appr-1"), since: expect.any(Date) as Date }]);
      expect(gh.looked[0]!.since.getTime()).toBeLessThanOrEqual(Date.parse(crashed.flowApprovalAt!));
      expect(log.filter((l) => l.startsWith("github create"))).toHaveLength(1);
    },
  );

  it("the approval was recorded but GitHub never created the issue: the redelivery finds none and creates one", async () => {
    gh = fakeGitHub(log, { fail: { create: new Error("connection reset") } });
    services.tracker = gh.tracker;
    expect((await deliver(approved())).outcome).toBe("retry");
    expect((await savedNote()).flowApprovalId).toBe("appr-1");
    const working = fakeGitHub(log);
    services.tracker = working.tracker;
    const { answers } = await deliver(approved());
    expect(answers).toMatchObject([{ type: ISSUE_CREATED }]);
    expect(working.looked).toHaveLength(1);
    expect(working.issues).toHaveLength(1);
  });

  it("a GitHub that can't be asked for the marker is github_unavailable, and nothing is created", async () => {
    db.failOn = (sql) => sql === "COMMIT";
    await deliver(approved());
    const failing = fakeGitHub(log, { fail: { findByMarker: new GitHubUnavailableError("HTTP 503") } });
    services.tracker = failing.tracker;
    await deliver(approved());
    expect(answers()).toMatchObject([{ type: ISSUE_FAILED, data: { code: "github_unavailable" } }]);
    expect(failing.issues).toEqual([]);
  });

  it("another approval (a new decision) isn't a redelivery: no search, a new marker", async () => {
    await store.recordFlowApproval("owner", noteId, "appr-0");
    await deliver(approved());
    expect(gh.looked).toEqual([]);
    expect(gh.issues[0]!.body).toContain(approvalMarker("appr-1"));
    expect((await savedNote()).flowApprovalId).toBe("appr-1");
  });
});

describe("GitHub's client: looking for the marker", () => {
  const since = new Date("2026-10-27T11:55:00.000Z");
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("lists the issues the token's user opened since then (never the search API) and finds the marker", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/user")) return reply({ login: "docs-bot" });
      return reply([
        { html_url: `https://github.com/${REPO}/issues/3`, number: 3, body: "another" },
        { html_url: `https://github.com/${REPO}/issues/4`, number: 4, body: `x\n\n${approvalMarker("appr-1")}` },
      ]);
    });
    const tracker = createGitHubIssues({ token: "t", fetch: fetchMock as never });
    expect(await tracker.findByMarker(REPO, approvalMarker("appr-1"), since)).toEqual({
      url: `https://github.com/${REPO}/issues/4`,
      number: 4,
    });
    expect(urls).toEqual([
      "https://api.github.com/user",
      `https://api.github.com/repos/${REPO}/issues?creator=docs-bot&since=2026-10-27T11:55:00.000Z&state=all&per_page=100&page=1`,
    ]);
    expect(urls.some((u) => u.includes("/search/"))).toBe(false);
    // The login is asked once.
    await tracker.findByMarker(REPO, approvalMarker("appr-2"), since);
    expect(urls.filter((u) => u.endsWith("/user"))).toHaveLength(1);
  });

  it("reads the next page while a page is full, and answers null when no issue has the marker", async () => {
    const urls: string[] = [];
    const full = Array.from({ length: 100 }, (_, i) => ({ html_url: `u${i}`, number: i, body: "x" }));
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/user")) return reply({ login: "docs-bot" });
      return reply(url.endsWith("page=1") ? full : []);
    });
    const tracker = createGitHubIssues({ token: "t", fetch: fetchMock as never });
    expect(await tracker.findByMarker(REPO, "m", since)).toBeNull();
    expect(urls.filter((u) => u.includes("/issues?")).map((u) => u.slice(-6))).toEqual(["page=1", "page=2"]);
  });

  it("GitHub's 401/403/404 is no access, a 5xx unavailable", async () => {
    const denied = createGitHubIssues({ token: "t", fetch: (async () => reply({}, 403)) as never });
    await expect(denied.findByMarker(REPO, "m", since)).rejects.toBeInstanceOf(NoRepoAccessError);
    const down = createGitHubIssues({ token: "t", fetch: (async () => reply({}, 502)) as never });
    await expect(down.findByMarker(REPO, "m", since)).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("an e2e mock's URL is honoured only on loopback, so the token never goes to another host", async () => {
    expect(loopbackUrl("http://127.0.0.1:4191/")).toBe("http://127.0.0.1:4191");
    expect(loopbackUrl("http://localhost:4191")).toBe("http://localhost:4191");
    expect(loopbackUrl("https://evil.example.com")).toBeUndefined();
    expect(loopbackUrl("http://localhost.evil.example.com")).toBeUndefined();
    expect(loopbackUrl("file:///etc/passwd")).toBeUndefined();
    expect(loopbackUrl("not a url")).toBeUndefined();
    expect(loopbackUrl(undefined)).toBeUndefined();
    const urls: string[] = [];
    const tracker = createGitHubIssues({
      token: "t",
      baseUrl: "http://127.0.0.1:4191",
      fetch: (async (url: string) => {
        urls.push(url);
        return reply({ private: true });
      }) as never,
    });
    await tracker.repo(REPO);
    expect(urls).toEqual([`http://127.0.0.1:4191/repos/${REPO}`]);
  });
});
