/**
 * Every page and server action of the app, found on disk: a page added later is checked without anyone
 * remembering to. Not signed in → the 401 sign-in page; signed in without flow.read → 403; the
 * Approvals pages are 403 without flow.approvals.decide, even with flow.read; and each server action
 * asks for its own permission (flow.runs.start, flow.workflows.write, flow.approvals.decide) before it
 * changes anything. The database and the engine are stand-ins that record what was asked of them.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ForbiddenError } from "@asafarim/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
};
/** Pages that ask for more than flow.read. */
const PAGE_PERMISSION: Record<string, string> = {
  "approvals/page.tsx": "flow.approvals.decide",
  "approvals/[id]/page.tsx": "flow.approvals.decide",
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
    inTransaction: async (_pool: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    engine: {
      retry: record("retry"),
      cancel: record("cancel"),
      setWorkflowStatus: record("setWorkflowStatus"),
      approve: record("approve"),
      reject: record("reject"),
    },
  };
});
vi.mock("@/lib/queries", () => ({
  overview: async () => ({ waiting: [], failures: [], latest: [] }),
  listRuns: async () => [],
  getRun: async () => undefined,
  listWorkflows: async () => [],
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
  return Page({ searchParams: Promise.resolve({}), params: Promise.resolve({ id: RUN }) });
}

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}
const FORM = { runId: RUN, approvalId: RUN, workflow: "docs-note-to-issue", status: "paused", title: "T" };

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
      "page.tsx",
      "runs/[id]/page.tsx",
      "runs/page.tsx",
      "workflows/page.tsx",
    ]);
    // No API of its own yet: the route files are sign-in plumbing and health.
    expect(handlers).toEqual(Object.keys(PUBLIC).sort());
    expect(actionFiles).toEqual(["actions.ts"]);
  });

  it("every server action is listed with the permission it needs", async () => {
    const mod = await load<Record<string, unknown>>("actions.ts");
    const exported = Object.entries(mod)
      .filter(([, fn]) => typeof fn === "function")
      .map(([name]) => name);
    expect(exported.sort()).toEqual(Object.keys(ACTIONS).sort());
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
    const mod = await load<Record<string, (f: FormData) => Promise<void>>>("actions.ts");
    const stop = await interruptOf(() => mod[name]!(form(FORM)));
    expect(stop?.kind).toBe("redirect");
    expect(stop?.to).toContain("error=forbidden");
    expect(stop?.to).toContain(`permission=${permission}`);
    expect(calls.engine).toEqual([]);
  });

  it.each(gated)("%s with %s: the engine does it", async (name, permission) => {
    who.subject = "dev-owner";
    who.permissions = ["flow.read", permission];
    const mod = await load<Record<string, (f: FormData) => Promise<void>>>("actions.ts");
    expect((await interruptOf(() => mod[name]!(form(FORM))))?.kind).toBe("redirect");
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
