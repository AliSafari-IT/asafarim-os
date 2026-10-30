/**
 * Every page and server action of the app, found on disk: a page added later is checked without anyone
 * remembering to. Not signed in → the 401 sign-in page; signed in without flow.read → 403; the
 * Approvals pages are 403 without flow.approvals.decide and Credentials without
 * flow.credentials.write, even with flow.read; and each server action
 * asks for its own permission (flow.runs.start, flow.workflows.write, flow.approvals.decide,
 * flow.credentials.write, flow.settings.write) before it
 * changes anything. The database and the engine are stand-ins that record what was asked of them.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ForbiddenError } from "@asafarim/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Settings from "@/lib/settings";

const APP = path.resolve(import.meta.dirname, "../app");
const files = readdirSync(APP, { recursive: true })
  .map((f) => String(f).split(path.sep).join("/"))
  .sort();
const pages = files.filter((f) => /(^|\/)page\.tsx$/.test(f));
const handlers = files.filter((f) => /(^|\/)route\.ts$/.test(f));
const actionFiles = files.filter(
  (f) => /\.tsx?$/.test(f) && /^\s*["']use server["']/.test(readFileSync(path.join(APP, f), "utf8")),
);

/** Route handlers that answer without sign-in, and why. Any other route file has to be gated. */
const PUBLIC: Record<string, string> = {
  "api/auth/[...nextauth]/route.ts": "the sign-in flow itself",
  "api/asafarim/session/route.ts": "sends a signed-out browser to sign-in",
  "health/live/route.ts": "liveness for the OS, no data",
  "health/ready/route.ts": "readiness for the OS, no data",
  "hooks/[id]/route.ts": "webhook in: the hook's signature authenticates a call (test/hooks.test.ts)",
};
/** Each server action and the permission it needs (none: signing in and out). */
const ACTIONS: Record<string, string | null> = {
  signInAction: null,
  signOutAction: null,
  retryRunAction: "flow.runs.start",
  cancelRunAction: "flow.runs.start",
  setWorkflowStatusAction: "flow.workflows.write",
  approveAction: "flow.approvals.decide",
  rejectAction: "flow.approvals.decide",
  runNowAction: "flow.runs.start",
  createCredentialAction: "flow.credentials.write",
  rotateCredentialAction: "flow.credentials.write",
  deleteCredentialAction: "flow.credentials.write",
  saveEgressHostsAction: "flow.settings.write",
  saveEmailRecipientsAction: "flow.settings.write",
  setPausedAllAction: "flow.settings.write",
  setAiGenerationAction: "flow.settings.write",
  generateWorkflowAction: "flow.workflows.generate",
  createWorkflowAction: "flow.workflows.write",
  duplicateWorkflowAction: "flow.workflows.write",
  createHookAction: "flow.workflows.write",
  regenerateHookAction: "flow.workflows.write",
  deleteHookAction: "flow.workflows.write",
};
/** Actions that answer their form (useActionState) instead of redirecting: (state, formData). */
const STATE_ACTIONS = new Set([
  "createCredentialAction",
  "rotateCredentialAction",
  "createHookAction",
  "regenerateHookAction",
]);
/** The builder's server functions (components/builder): they answer with a result, not a redirect. */
const DRAFT_FUNCTIONS: Record<
  string,
  {
    engine: string;
    call: (fn: (...a: unknown[]) => Promise<unknown>) => Promise<unknown>;
    /** The same call with input that doesn't fit: refused after the gate, before the engine. */
    bad: (fn: (...a: unknown[]) => Promise<unknown>) => Promise<unknown>;
  }
> = {
  saveDraft: {
    engine: "saveDraft",
    call: (fn) => fn("my-flow", { version: 2, key: "my-flow" }, null),
    bad: (fn) => fn("my-flow", { version: 2, key: "my-flow" }, "yesterday"),
  },
  validateDraft: {
    engine: "checkDefinition",
    call: (fn) => fn("my-flow", { version: 2, key: "my-flow" }),
    bad: (fn) => fn("my-flow", { version: 2, key: "my-flow", pad: "x".repeat(300_000) }),
  },
  publishDraft: { engine: "publishDraft", call: (fn) => fn("my-flow"), bad: (fn) => fn({ key: "my-flow" }) },
  testDraft: {
    engine: "startDraftRun",
    call: (fn) => fn("my-flow", {}, true),
    bad: (fn) => fn("my-flow", [], "yes"),
  },
  importWorkflowFileAction: {
    engine: "saveDraft",
    call: (fn) =>
      fn(
        "Imported workflow",
        "my-flow",
        JSON.stringify({
          format: "asafarim.flow.workflow",
          version: 1,
          exportedAt: "2026-10-30T00:00:00.000Z",
          definition: {
            version: 2,
            key: "source-flow",
            trigger: { type: "manual", input: [] },
            start: "done",
            nodes: [{ key: "done", type: "end" }],
          },
        }),
      ),
    bad: (fn) => fn("Imported workflow", "invalid key", "{}"),
  },
};

/** Pages that ask for more than flow.read. */
const PAGE_PERMISSION: Record<string, string> = {
  "approvals/page.tsx": "flow.approvals.decide",
  "approvals/[id]/page.tsx": "flow.approvals.decide",
  "credentials/page.tsx": "flow.credentials.write",
  "workflows/new/page.tsx": "flow.workflows.write",
};

const who = vi.hoisted(() => ({ subject: undefined as string | undefined, permissions: [] as string[] }));
const calls = vi.hoisted(() => ({ db: 0, engine: [] as string[] }));

class Interrupt extends Error {
  constructor(
    readonly kind: "unauthorized" | "forbidden" | "redirect" | "notFound",
    readonly to?: string,
  ) {
    super(kind);
  }
}

vi.mock("next/navigation", () => ({
  unauthorized: () => {
    throw new Interrupt("unauthorized");
  },
  forbidden: () => {
    throw new Interrupt("forbidden");
  },
  notFound: () => {
    throw new Interrupt("notFound");
  },
  redirect: (to: string) => {
    throw new Interrupt("redirect", to);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (who.subject ? { user: { id: who.subject, name: who.subject } } : null),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({
  getPlatform: () => ({
    access: {
      access: async () => ({ state: "active", roles: [], permissions: who.permissions }),
      require: async (_session: unknown, permission: string) => {
        if (!who.permissions.includes(permission)) throw new ForbiddenError(permission);
      },
      launcher: async () => [],
    },
  }),
}));
vi.mock("@/lib/db", () => {
  const record = (name: string) => async () => {
    calls.engine.push(name);
    return { ok: true, audits: [] };
  };
  return {
    db: async () => {
      calls.db++;
      return {};
    },
    inTransaction: async (_pool: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: [] }) }),
    engine: {
      retry: record("retry"),
      cancel: record("cancel"),
      setWorkflowStatus: record("setWorkflowStatus"),
      approve: record("approve"),
      reject: record("reject"),
      startRun: record("startRun"),
      saveDraft: async () => {
        calls.engine.push("saveDraft");
        return { ok: true, problems: [], workflowId: "w", draftUpdatedAt: new Date(0), audits: [] };
      },
      checkDefinition: () => {
        calls.engine.push("checkDefinition");
        return [];
      },
      publishDraft: record("publishDraft"),
      startDraftRun: record("startDraftRun"),
    },
  };
});
vi.mock("@/lib/credentials/store", () => {
  const record = (name: string) => async () => {
    calls.engine.push(name);
    return { ok: true, id: "x", kind: "webhook-secret", audits: [] };
  };
  return {
    createCredential: record("createCredential"),
    rotateCredential: record("rotateCredential"),
    deleteCredential: record("deleteCredential"),
    listCredentials: async () => [],
    credentialsAvailable: () => true,
  };
});
vi.mock("@/lib/hooks/store", () => {
  const record = (name: string) => async () => {
    calls.engine.push(name);
    return { ok: true, id: "AAAAAAAAAAAAAAAAAAAAAA", kind: "generic", workflowKey: "my-flow", audits: [] };
  };
  return {
    createHook: record("createHook"),
    regenerateHookSecret: record("regenerateHookSecret"),
    deleteHook: record("deleteHook"),
    listHooks: async () => [],
  };
});
vi.mock("@/lib/settings", async (importActual) => {
  const actual = await importActual<typeof Settings>();
  const record = (name: string) => async () => {
    calls.engine.push(name);
    return { audits: [] };
  };
  return {
    ...actual,
    getSettings: async () => ({ egressHosts: [], emailRecipients: [], pausedAll: false, aiGeneration: false }),
    setList: record("setList"),
    setPausedAll: record("setPausedAll"),
    setAiGeneration: record("setAiGeneration"),
  };
});
// Generate from issue (#283): available, within limits, and a draft from the (fake) AI; only saving it
// reaches the engine. lib/generate is unit- and integration-tested on its own.
vi.mock("@/lib/generate/service", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  availability: async () => ({ ok: true }),
  checkLimits: async () => ({ ok: true }),
  issueToken: async () => ({ ok: true }),
  recordGeneration: async () => undefined,
  generatedInfo: async () => null,
}));
vi.mock("@/lib/generate", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  aiConfigFromEnv: () => ({ apiKey: "k", model: "claude-opus-5-5", effort: "medium" }),
  generateDraft: async (_url: string, key: string) => ({
    ok: true,
    draft: {
      definition: {
        version: 2,
        key,
        trigger: { type: "manual", input: [] },
        start: "done",
        nodes: [{ key: "done", type: "end" }],
      },
      notes: {},
      name: "Generated",
      summary: "",
      triggerNote: "",
    },
    source: { host: "github", repo: "acme/shop", number: 42 },
    model: "claude-opus-5-5",
    usage: { inputTokens: 1, outputTokens: 1 },
    redactions: 0,
  }),
}));
vi.mock("@/lib/queries", () => ({
  overview: async () => ({ waiting: [], failures: [], latest: [] }),
  listRuns: async () => [],
  getRun: async () => undefined,
  listWorkflows: async () => [],
  getBuilderWorkflow: async (_p: unknown, key: string) =>
    key === "docs-note-to-issue"
      ? {
          id: "w1",
          key,
          name: "Docs note to issue",
          status: "active",
          draft: null,
          draftUpdatedAt: null,
          draftUpdatedBy: null,
          versions: [],
          current: null,
        }
      : undefined,
  getVersions: async () => [],
  listPendingApprovals: async () => [],
  getApproval: async () => undefined,
}));

async function load<T>(file: string): Promise<T> {
  return (await import(path.join(APP, file))) as T;
}

async function interruptOf(run: () => Promise<unknown>): Promise<Interrupt | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    if (err instanceof Interrupt) return err;
    throw err;
  }
}

const RUN = "01JZ8Q0000000000000000000A";
async function renderPage(file: string) {
  const { default: Page } = await load<{ default: (p: unknown) => Promise<unknown> }>(file);
  return Page({
    searchParams: Promise.resolve({}),
    params: Promise.resolve({ id: RUN, key: "docs-note-to-issue" }),
  });
}

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}
const FORM = {
  runId: RUN,
  approvalId: RUN,
  credentialId: RUN,
  hookId: "AAAAAAAAAAAAAAAAAAAAAA",
  workflow: "docs-note-to-issue",
  status: "paused",
  title: "T",
  kind: "webhook-secret",
  name: "Hook",
  entries: "hooks.example.com",
  pausedAll: "on",
  key: "my-flow",
  trigger: "manual",
  issueUrl: "https://github.com/acme/shop/issues/42",
  credential: "",
};
type Action = (...a: unknown[]) => Promise<unknown>;
/** Run an action the way its form does: a redirect is an Interrupt, a state action's answer is returned. */
async function runAction(name: string): Promise<{ stop?: Interrupt; answer?: unknown }> {
  const mod = await load<Record<string, Action>>("actions.ts");
  if (name === "saveEmailRecipientsAction")
    return { stop: await interruptOf(() => mod[name]!(form({ ...FORM, entries: "@example.com" }))) };
  if (STATE_ACTIONS.has(name)) return { answer: await mod[name]!({ status: "idle" }, form(FORM)) };
  return { stop: await interruptOf(() => mod[name]!(form(FORM))) };
}

beforeEach(() => {
  who.subject = undefined;
  who.permissions = [];
  calls.db = 0;
  calls.engine = [];
});

describe("the routes on disk", () => {
  it("finds the pages, the route handlers and the server actions", () => {
    expect(pages).toEqual([
      "approvals/[id]/page.tsx",
      "approvals/page.tsx",
      "credentials/page.tsx",
      "page.tsx",
      "runs/[id]/page.tsx",
      "runs/page.tsx",
      "settings/page.tsx",
      "workflows/[key]/edit/page.tsx",
      "workflows/[key]/versions/page.tsx",
      "workflows/new/page.tsx",
      "workflows/page.tsx",
    ]);
    // The route files are sign-in plumbing, health and webhook in.
    expect(handlers).toEqual(Object.keys(PUBLIC).sort());
    expect(actionFiles).toEqual(["actions.ts"]);
  });

  it("every server action is listed with the permission it needs", async () => {
    const mod = await load<Record<string, unknown>>("actions.ts");
    const exported = Object.entries(mod)
      .filter(([, fn]) => typeof fn === "function")
      .map(([name]) => name);
    expect(exported.sort()).toEqual([...Object.keys(ACTIONS), ...Object.keys(DRAFT_FUNCTIONS)].sort());
  });
});

describe("not signed in", () => {
  it.each(pages)("page %s is the 401 sign-in page, and reads nothing", async (file) => {
    expect((await interruptOf(() => renderPage(file)))?.kind).toBe("unauthorized");
    expect(calls.db).toBe(0);
  });
});

describe("signed in without flow.read", () => {
  it.each(pages)("page %s is 403, and reads nothing", async (file) => {
    who.subject = "dev-member";
    expect((await interruptOf(() => renderPage(file)))?.kind).toBe("forbidden");
    expect(calls.db).toBe(0);
  });
});

describe("with flow.read", () => {
  const detail = ["runs/[id]/page.tsx", "approvals/[id]/page.tsx"];
  it.each(pages.filter((p) => !detail.includes(p) && !PAGE_PERMISSION[p]))("page %s renders", async (file) => {
    who.subject = "dev-viewer";
    who.permissions = ["flow.read"];
    expect(await interruptOf(() => renderPage(file))).toBeUndefined();
  });

  it("a run that doesn't exist is a 404", async () => {
    who.subject = "dev-viewer";
    who.permissions = ["flow.read"];
    expect((await interruptOf(() => renderPage("runs/[id]/page.tsx")))?.kind).toBe("notFound");
  });

  it.each(Object.entries(PAGE_PERMISSION))("page %s without %s is 403, and reads nothing", async (file) => {
    who.subject = "dev-viewer";
    who.permissions = ["flow.read"];
    expect((await interruptOf(() => renderPage(file)))?.kind).toBe("forbidden");
    expect(calls.db).toBe(0);
  });
});

describe("with flow.approvals.decide", () => {
  it("the Approvals page renders", async () => {
    who.subject = "dev-approver";
    who.permissions = ["flow.read", "flow.approvals.decide"];
    expect(await interruptOf(() => renderPage("approvals/page.tsx"))).toBeUndefined();
  });

  it("an approval that doesn't exist is a 404", async () => {
    who.subject = "dev-approver";
    who.permissions = ["flow.read", "flow.approvals.decide"];
    expect((await interruptOf(() => renderPage("approvals/[id]/page.tsx")))?.kind).toBe("notFound");
  });
});

describe("server actions", () => {
  const gated = Object.entries(ACTIONS).filter((e): e is [string, string] => e[1] !== null);

  it.each(gated)("%s without %s: refused (naming it), the engine isn't called", async (name, permission) => {
    who.subject = "dev-viewer";
    who.permissions = ["flow.read"];
    const { stop, answer } = await runAction(name);
    if (STATE_ACTIONS.has(name)) {
      expect(answer).toEqual({ status: "error", error: "forbidden", permission });
    } else {
      expect(stop?.kind).toBe("redirect");
      expect(stop?.to).toContain("error=forbidden");
      expect(stop?.to).toContain(`permission=${permission}`);
    }
    expect(calls.engine).toEqual([]);
  });

  it.each(gated)("%s with %s: the engine does it", async (name, permission) => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", permission];
    const { stop, answer } = await runAction(name);
    if (STATE_ACTIONS.has(name)) expect(answer).toMatchObject({ status: "done" });
    else expect(stop?.kind).toBe("redirect");
    expect(calls.engine).toHaveLength(1);
  });

  it.each([
    ["saveEgressHostsAction", "egress_hosts"],
    ["saveEmailRecipientsAction", "email_recipients"],
    ["setPausedAllAction", "paused"],
    ["setAiGenerationAction", "ai_off"],
  ])("%s reports the completed settings update", async (name, saved) => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", "flow.settings.write"];
    const { stop } = await runAction(name);
    expect(stop).toMatchObject({ kind: "redirect", to: `/settings?saved=${saved}` });
    expect(calls.engine).toHaveLength(1);
  });

  it("a run id that isn't one goes back to the runs, before anything else", async () => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", "flow.runs.start"];
    const mod = await load<Record<string, (f: FormData) => Promise<void>>>("actions.ts");
    const stop = await interruptOf(() => mod.retryRunAction!(form({ runId: "../../etc" })));
    expect(stop).toMatchObject({ kind: "redirect", to: "/runs" });
    expect(calls.engine).toEqual([]);
  });
});

describe("the builder's server functions (flow.workflows.write)", () => {
  it.each(Object.entries(DRAFT_FUNCTIONS))(
    "%s without it: refused, naming it; the engine isn't called",
    async (name, d) => {
      who.subject = "dev-viewer";
      who.permissions = ["flow.read", "flow.runs.start"];
      const mod = await load<Record<string, (...a: unknown[]) => Promise<unknown>>>("actions.ts");
      expect(await d.call(mod[name]!)).toEqual({ ok: false, error: "forbidden", permission: "flow.workflows.write" });
      expect(calls.engine).toEqual([]);
    },
  );

  it.each(Object.entries(DRAFT_FUNCTIONS))(
    "%s with it: the engine does it, the audits stay inside",
    async (name, d) => {
      who.subject = "dev-owner";
      who.permissions = ["flow.read", "flow.workflows.write"];
      const mod = await load<Record<string, (...a: unknown[]) => Promise<unknown>>>("actions.ts");
      expect(await d.call(mod[name]!)).toMatchObject({ ok: true });
      expect(calls.engine).toEqual([d.engine]);
    },
  );

  it.each(Object.entries(DRAFT_FUNCTIONS))(
    "%s with it, and input that doesn't fit: invalid_input, the engine isn't called",
    async (name, d) => {
      who.subject = "dev-owner";
      who.permissions = ["flow.read", "flow.workflows.write"];
      const mod = await load<Record<string, (...a: unknown[]) => Promise<unknown>>>("actions.ts");
      expect(await d.bad(mod[name]!)).toMatchObject({ ok: false });
      expect(calls.engine).toEqual([]);
    },
  );

  it("New and Duplicate refuse a key that isn't one, before the engine", async () => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", "flow.workflows.write"];
    const mod = await load<Record<string, (f: FormData) => Promise<void>>>("actions.ts");
    expect(await interruptOf(() => mod.createWorkflowAction!(form({ ...FORM, key: "Not A Key" })))).toMatchObject({
      to: "/workflows/new?error=invalid_workflow",
    });
    expect(
      await interruptOf(() => mod.createWorkflowAction!(form({ ...FORM, trigger: "carrier-pigeon" }))),
    ).toMatchObject({
      to: "/workflows/new?error=invalid_workflow",
    });
    expect(await interruptOf(() => mod.duplicateWorkflowAction!(form({ ...FORM, key: "../x" })))).toMatchObject({
      to: "/workflows?error=invalid_workflow",
    });
    expect(calls.engine).toEqual([]);
  });
});

describe("the decisions", () => {
  it("an approval id that isn't one goes back to Approvals, before anything else", async () => {
    who.subject = "dev-approver";
    who.permissions = ["flow.read", "flow.approvals.decide"];
    const mod = await load<Record<string, (f: FormData) => Promise<void>>>("actions.ts");
    for (const name of ["approveAction", "rejectAction"]) {
      const stop = await interruptOf(() => mod[name]!(form({ approvalId: "../x" })));
      expect(stop).toMatchObject({ kind: "redirect", to: "/approvals" });
    }
    expect(calls.engine).toEqual([]);
  });
});

describe("Run now under the kill switch", () => {
  it("startRun's paused_all comes back to the Workflows page with its own message", async () => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", "flow.runs.start"];
    const { engine } = (await import("@/lib/db")) as unknown as {
      engine: { startRun: (...a: unknown[]) => Promise<unknown> };
    };
    const startRun = engine.startRun;
    engine.startRun = async () => ({ ok: false, error: "paused_all", audits: [] });
    try {
      const mod = await load<Record<string, (f: FormData) => Promise<void>>>("actions.ts");
      const stop = await interruptOf(() => mod.runNowAction!(form({ workflow: "echo-flow" })));
      expect(stop).toMatchObject({ kind: "redirect", to: "/workflows?error=paused_all" });
    } finally {
      engine.startRun = startRun;
    }
    const { ErrorNotice } = await import("@/components/Notice");
    expect(JSON.stringify(ErrorNotice({ error: "paused_all" }))).toContain(
      "All workflows are paused. Resume them in Settings to run this one.",
    );
  });
});

describe("generate from issue (#283)", () => {
  it("saves the generated draft as a new workflow and opens the builder on it", async () => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", "flow.workflows.generate"];
    const { stop } = await runAction("generateWorkflowAction");
    expect(stop?.kind).toBe("redirect");
    expect(stop?.to).toMatch(/^\/workflows\/gen-shop-42-[a-z0-9]{6}\/edit\?generated=1$/);
    expect(calls.engine).toEqual(["saveDraft"]);
  });

  it("refuses a URL that isn't an issue URL before anything else", async () => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", "flow.workflows.generate"];
    const mod = await load<Record<string, (f: FormData) => Promise<void>>>("actions.ts");
    const stop = await interruptOf(() =>
      mod.generateWorkflowAction!(form({ issueUrl: "https://github.com.evil.example/a/b/issues/1", credential: "" })),
    );
    expect(stop).toMatchObject({ kind: "redirect", to: "/workflows/new?error=generate_invalid_url" });
    expect(calls.engine).toEqual([]);
  });

  it("flow.workflows.write alone isn't enough", async () => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", "flow.workflows.write"];
    const { stop } = await runAction("generateWorkflowAction");
    expect(stop?.to).toContain("permission=flow.workflows.generate");
    expect(calls.engine).toEqual([]);
  });
});
