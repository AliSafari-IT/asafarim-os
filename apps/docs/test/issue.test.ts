/**
 * "Generate GitHub issue" (#82): the context the AI gets, the validation of its answer, the two
 * outside clients, and the routes. The AI and GitHub are always mocked; the tests prove nothing is
 * created on GitHub before "Create issue" and that a bad AI answer creates nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ForbiddenError } from "@asafarim/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiTimeoutError,
  createAnthropicWriter,
  createGitHubIssues,
  NoRepoAccessError,
  type IssueTracker,
  type IssueWriter,
} from "../lib/issue-clients";
import { buildIssueContext, sectionTexts } from "../lib/issue-context";
import { existingLabels, IssueDraft, issuePrompt, linksToApp, withoutAppLinks } from "../lib/issue-draft";
import type { Note, NotesStore } from "../lib/notes";
import { createFixtureBackend, createSource } from "../lib/source";

const who = vi.hoisted(() => ({ subject: undefined as string | undefined, permissions: [] as string[] }));
const services = vi.hoisted(() => ({
  store: null as NotesStore | null,
  tracker: null as IssueTracker | null,
  writer: null as IssueWriter | null,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (who.subject ? { user: { id: who.subject } } : null),
}));
vi.mock("@/lib/platform", () => ({
  getPlatform: () => ({
    config: {
      getString: (k: string) =>
        k === "source.repo" ? "example-org/handbook" : k === "ai.model" ? "claude-test" : "main",
    },
    access: {
      access: async () => ({ state: "active", roles: [], permissions: who.permissions }),
      require: async (_s: unknown, permission: string) => {
        if (!who.permissions.includes(permission)) throw new ForbiddenError(permission);
      },
    },
  }),
}));
const fixtures = createSource(createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures")));
vi.mock("@/lib/source", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSource: () => fixtures,
}));
vi.mock("@/lib/notes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getNotes: () => services.store,
}));
vi.mock("@/lib/issue-clients", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getIssueTracker: () => services.tracker,
  getIssueWriter: () => services.writer,
}));

const ROADMAP = "ventures/demo-app/roadmap/roadmap.md";
const roadmap = readFileSync(path.resolve(import.meta.dirname, "../fixtures", ROADMAP), "utf8");

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

/** Notes in memory, scoped to their author like the real store. */
function memoryStore(): NotesStore & { notes: (Note & { author: string })[] } {
  const notes: (Note & { author: string })[] = [];
  let next = 1;
  const own = (author: string, id: string) => notes.find((n) => n.author === author && n.id === id) ?? null;
  return {
    notes,
    async list(author) {
      return notes.filter((n) => n.author === author);
    },
    async get(author, id) {
      return own(author, id);
    },
    async create(author, input) {
      const now = new Date().toISOString();
      const note = { ...input, id: String(next++), author, issueUrl: null, createdAt: now, updatedAt: now };
      notes.push(note);
      return note;
    },
    async update(author, id, body) {
      const n = own(author, id);
      if (n) n.body = body;
      return n;
    },
    async remove(author, id) {
      const i = notes.findIndex((n) => n.author === author && n.id === id);
      if (i !== -1) notes.splice(i, 1);
      return i !== -1;
    },
    async setIssueUrl(author, id, url) {
      const n = own(author, id);
      if (n) n.issueUrl = url;
      return n;
    },
  };
}

function fakeTracker(opts: { public?: boolean; noAccess?: string[] } = {}) {
  const calls: { op: string; repo: string; issue?: unknown }[] = [];
  const check = (repo: string) => {
    if (opts.noAccess?.includes(repo)) throw new NoRepoAccessError(repo);
  };
  const tracker: IssueTracker = {
    async repo(repo) {
      calls.push({ op: "repo", repo });
      check(repo);
      return { public: opts.public ?? false };
    },
    async labels(repo) {
      calls.push({ op: "labels", repo });
      check(repo);
      return ["bug", "enhancement", "docs"];
    },
    async create(repo, issue) {
      calls.push({ op: "create", repo, issue });
      check(repo);
      return { url: `https://github.com/${repo}/issues/7`, number: 7 };
    },
  };
  return { tracker, calls };
}

function fakeWriter(answer: unknown | (() => never)) {
  const prompts: { system: string; user: string }[] = [];
  const writer: IssueWriter = {
    async draft(prompt) {
      prompts.push(prompt);
      if (typeof answer === "function") (answer as () => never)();
      return { answer, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  return { writer, prompts };
}

describe("the context the AI gets (#82)", () => {
  it("splits the document at its headings with the page's ids and the heading path", () => {
    const tracking = sectionTexts(roadmap).find((s) => s.id === "tracking");
    expect(tracking?.path).toEqual(["Setup", "Tracking"]);
    expect(tracking?.text).toContain("The beta is tracked in example-org/demo-app#12.");
  });

  it("carries the right section, title, outline, links, note, quote and labels", () => {
    const c = buildIssueContext({
      docPath: ROADMAP,
      markdown: roadmap,
      note: { headingId: "tracking", quote: "The beta is tracked", body: "Link the beta to a milestone." },
      repo: "example-org/demo-app",
      labels: ["bug", "docs"],
    });
    expect(c).toMatchObject({
      title: "Demo app roadmap",
      headingPath: ["Setup", "Tracking"],
      quote: "The beta is tracked",
      note: "Link the beta to a milestone.",
      issueLinks: ["https://github.com/example-org/demo-app/issues/12"],
      repo: "example-org/demo-app",
    });
    expect(c.outline).toEqual(["- Milestones", "- Timeline", "- Architecture", "- Setup", "  - Tracking"]);
    expect(c.sectionText).not.toContain("Milestone | Owner");
    const { user, system } = issuePrompt(c, true);
    expect(user).toContain("Section: Setup › Tracking");
    expect(user).toContain("Existing labels in example-org/demo-app: bug, docs");
    expect(system).toContain("PUBLIC");
  });

  it("stays within the word budget: the outline goes first, then the section is cut", () => {
    const long = `# T\n\n## A\n\n${"word ".repeat(5000)}\n\n## B\n\n## C\n`;
    const c = buildIssueContext({
      docPath: "x.md",
      markdown: long,
      note: { headingId: "a", quote: "", body: "Shorten it." },
      repo: "o/r",
      labels: [],
      maxWords: 300,
    });
    expect(c.outline).toEqual([]);
    expect(c.sectionText.endsWith("[…]")).toBe(true);
    expect(c.words).toBeLessThan(400);
  });

  it("a heading that is gone falls back to the text before the first heading", () => {
    const c = buildIssueContext({
      docPath: ROADMAP,
      markdown: roadmap,
      note: { headingId: "gone", quote: "", body: "x" },
      repo: "o/r",
      labels: [],
    });
    expect(c.headingPath).toEqual([]);
    expect(c.sectionText).toContain("A made-up roadmap");
  });
});

describe("the AI's answer (#82)", () => {
  it("needs a title and the four sections", () => {
    expect(IssueDraft.safeParse({ title: "Ship it", body: GOOD_BODY, labels: [] }).success).toBe(true);
    expect(IssueDraft.safeParse({ title: "Ship it", body: "## Context\nonly", labels: [] }).success).toBe(false);
    expect(IssueDraft.safeParse({ title: "", body: GOOD_BODY }).success).toBe(false);
    expect(IssueDraft.safeParse("free text").success).toBe(false);
  });

  it("keeps only labels the repo has, spelled as the repo spells them", () => {
    expect(existingLabels(["Bug", "made-up", "bug", "docs"], ["bug", "docs"])).toEqual(["bug", "docs"]);
  });

  it("replaces links to the reader with the document's path", () => {
    const d = withoutAppLinks(
      { title: "t", body: `See https://docs.asafarim.site/?doc=a.md#x and docs.asafarim.site.`, labels: [] },
      "docs.asafarim.site",
      "a.md",
    );
    expect(d.body).toBe("See a.md and docs.asafarim.site.");
    expect(linksToApp("https://docs.asafarim.site/x", "docs.asafarim.site")).toBe(true);
    expect(linksToApp("https://github.com/o/r", "docs.asafarim.site")).toBe(false);
  });
});

describe("the outside clients (#82)", () => {
  it("Anthropic: forces the issue tool and returns its input and the token usage", async () => {
    const sent: RequestInit[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      sent.push(init);
      return Response.json({
        content: [{ type: "tool_use", name: "issue_draft", input: { title: "t" } }],
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    }) as unknown as typeof fetch;
    const w = createAnthropicWriter({ apiKey: "k", model: "claude-test", fetch: fetchMock });
    expect(await w.draft({ system: "s", user: "u" })).toEqual({
      answer: { title: "t" },
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const body = JSON.parse(String(sent[0]!.body));
    expect(body).toMatchObject({ model: "claude-test", tool_choice: { type: "auto" } });
  });

  it("Anthropic: a timeout is an AiTimeoutError", async () => {
    const fetchMock = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    const w = createAnthropicWriter({ apiKey: "k", model: "m", fetch: fetchMock, timeoutMs: 10 });
    await expect(w.draft({ system: "s", user: "u" })).rejects.toBeInstanceOf(AiTimeoutError);
  });

  it("GitHub: 404 or 403 is 'No access to <repo>', and the public flag comes from the repo", async () => {
    const fetchMock = (async (url: string) =>
      url.includes("/hidden")
        ? new Response("{}", { status: 404 })
        : Response.json({ private: false })) as unknown as typeof fetch;
    const gh = createGitHubIssues({ token: "t", fetch: fetchMock });
    expect(await gh.repo("o/open")).toEqual({ public: true });
    await expect(gh.repo("o/hidden")).rejects.toThrow("No access to o/hidden");
  });
});

const draftRoute = () => import("../app/api/notes/[id]/issue/draft/route");
const createRoute = () => import("../app/api/notes/[id]/issue/route");
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (body: unknown) =>
  new Request("http://docs.test/api/notes/1/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let store: ReturnType<typeof memoryStore>;
let noteIdOf: string;
beforeEach(async () => {
  who.subject = "owner";
  who.permissions = ["docs.read", "docs.notes.write", "docs.issues.create"];
  store = memoryStore();
  services.store = store;
  services.tracker = fakeTracker().tracker;
  services.writer = fakeWriter({ title: "Ship the beta", body: GOOD_BODY, labels: ["enhancement", "nope"] }).writer;
  noteIdOf = (
    await store.create("owner", {
      docPath: ROADMAP,
      headingId: "tracking",
      quote: "The beta is tracked",
      body: "Link it.",
      docSha: "0".repeat(64),
    })
  ).id;
});

describe("POST /api/notes/:id/issue/draft (#82)", () => {
  it("drafts for the repo that owns the document, and creates nothing on GitHub", async () => {
    const gh = fakeTracker({ public: true });
    services.tracker = gh.tracker;
    const res = await (await draftRoute()).POST(jsonReq({}), params(noteIdOf));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      repo: "example-org/demo-app",
      public: true,
      draft: { title: "Ship the beta", labels: ["enhancement"] },
      labels: ["bug", "enhancement", "docs"],
      issueUrl: null,
    });
    expect(gh.calls.some((c) => c.op === "create")).toBe(false);
  });

  it("a bad AI answer is an error, and nothing is created", async () => {
    const gh = fakeTracker();
    services.tracker = gh.tracker;
    services.writer = fakeWriter({ title: "x", body: "no sections" }).writer;
    const res = await (await draftRoute()).POST(jsonReq({}), params(noteIdOf));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "invalid_ai_answer" });
    expect(gh.calls.some((c) => c.op === "create")).toBe(false);
  });

  it("a repo the token can't reach says so", async () => {
    services.tracker = fakeTracker({ noAccess: ["example-org/demo-app"] }).tracker;
    const res = await (await draftRoute()).POST(jsonReq({}), params(noteIdOf));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "no_repo_access", message: "No access to example-org/demo-app" });
  });

  it("an AI timeout asks to try again", async () => {
    services.writer = fakeWriter(() => {
      throw new AiTimeoutError();
    }).writer;
    const res = await (await draftRoute()).POST(jsonReq({}), params(noteIdOf));
    expect(res.status).toBe(504);
  });

  it("not configured: 503", async () => {
    services.writer = null;
    expect((await (await draftRoute()).POST(jsonReq({}), params(noteIdOf))).status).toBe(503);
  });

  it("needs docs.issues.create, and only the author's own note", async () => {
    who.permissions = ["docs.read", "docs.notes.write"];
    const forbidden = await (await draftRoute()).POST(jsonReq({}), params(noteIdOf));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ permission: "docs.issues.create" });
    who.permissions = ["docs.read", "docs.issues.create"];
    who.subject = "someone-else";
    expect((await (await draftRoute()).POST(jsonReq({}), params(noteIdOf))).status).toBe(404);
  });
});

describe("POST /api/notes/:id/issue (#82)", () => {
  const issue = { repo: "example-org/demo-app", title: "Ship the beta", body: GOOD_BODY, labels: ["docs", "nope"] };

  it("creates the issue with existing labels only and saves its URL on the note", async () => {
    const gh = fakeTracker();
    services.tracker = gh.tracker;
    const res = await (await createRoute()).POST(jsonReq(issue), params(noteIdOf));
    expect(res.status).toBe(201);
    const { note } = await res.json();
    expect(note.issueUrl).toBe("https://github.com/example-org/demo-app/issues/7");
    expect(gh.calls.filter((c) => c.op === "create")).toEqual([
      {
        op: "create",
        repo: "example-org/demo-app",
        issue: { title: "Ship the beta", body: GOOD_BODY, labels: ["docs"] },
      },
    ]);
  });

  it("a second issue from the same note needs confirmation", async () => {
    const { POST } = await createRoute();
    await POST(jsonReq(issue), params(noteIdOf));
    const again = await POST(jsonReq(issue), params(noteIdOf));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "issue_exists" });
    expect((await POST(jsonReq({ ...issue, confirm: true }), params(noteIdOf))).status).toBe(201);
  });

  it("the issue is created but its URL can't be saved: 500 with the issue, created exactly once", async () => {
    const gh = fakeTracker();
    services.tracker = gh.tracker;
    store.setIssueUrl = async () => {
      throw new Error("connection lost");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await (await createRoute()).POST(jsonReq(issue), params(noteIdOf));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "issue_url_not_saved",
      message: "The issue was created, but the link could not be saved on this note.",
      issue: { url: "https://github.com/example-org/demo-app/issues/7", number: 7 },
    });
    expect(gh.calls.filter((c) => c.op === "create")).toHaveLength(1);
    // Ids only: no title, body or error text.
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(JSON.parse(logged)).toMatchObject({ msg: "issue.url_not_saved", note: noteIdOf, issue: 7 });
    expect(logged).not.toContain("Ship the beta");
    expect(logged).not.toContain("connection lost");
    warn.mockRestore();
  });

  it("the note was deleted meanwhile: 410 note_gone with the issue, not a plain success", async () => {
    const gh = fakeTracker();
    services.tracker = gh.tracker;
    store.setIssueUrl = async () => null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await (await createRoute()).POST(jsonReq(issue), params(noteIdOf));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({
      error: "note_gone",
      issue: { url: "https://github.com/example-org/demo-app/issues/7", number: 7 },
    });
    expect(gh.calls.filter((c) => c.op === "create")).toHaveLength(1);
    warn.mockRestore();
  });

  it("a public repo needs the banner acknowledged: 409 and nothing created without it", async () => {
    const gh = fakeTracker({ public: true });
    services.tracker = gh.tracker;
    const { POST } = await createRoute();
    const res = await POST(jsonReq(issue), params(noteIdOf));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "public_not_acknowledged",
      repo: "example-org/demo-app",
      public: true,
    });
    expect(gh.calls.filter((c) => c.op === "create")).toEqual([]);
    expect(store.notes.find((n) => n.id === noteIdOf)?.issueUrl).toBeNull();

    const acked = await POST(jsonReq({ ...issue, acknowledgedPublic: true }), params(noteIdOf));
    expect(acked.status).toBe(201);
    expect(gh.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  it("a private repo needs no acknowledgement, and the visibility is asked before creating", async () => {
    const gh = fakeTracker({ public: false });
    services.tracker = gh.tracker;
    expect((await (await createRoute()).POST(jsonReq(issue), params(noteIdOf))).status).toBe(201);
    expect(gh.calls.map((c) => c.op)).toEqual(["repo", "labels", "create"]);
  });

  it("a repo the token can't reach is 'No access', and nothing is created", async () => {
    const gh = fakeTracker({ noAccess: ["example-org/demo-app"] });
    services.tracker = gh.tracker;
    const res = await (await createRoute()).POST(jsonReq(issue), params(noteIdOf));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "no_repo_access" });
    expect(gh.calls.filter((c) => c.op === "create")).toEqual([]);
  });

  it("refuses a link to the reader", async () => {
    const body = `${GOOD_BODY}\nhttps://docs.asafarim.site/?doc=x.md`;
    const gh = fakeTracker();
    services.tracker = gh.tracker;
    const res = await (await createRoute()).POST(jsonReq({ ...issue, body }), params(noteIdOf));
    expect(res.status).toBe(422);
    expect(gh.calls).toEqual([]);
  });
});
