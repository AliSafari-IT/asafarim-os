/**
 * Every route of the app, found on disk (#79): a page, a route handler or a server action added later
 * is checked here without anyone remembering to. Not signed in, nothing but the sign-in answer comes
 * back; signed in without docs.read, a 403 naming it; with it, the documents.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ForbiddenError } from "@asafarim/app-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as realSource from "../lib/source";
import { createFixtureBackend, createSource, type DocSource } from "../lib/source";

const APP = path.resolve(import.meta.dirname, "../app");

/** Routes that must answer without sign-in, and why. Anything else found on disk has to be gated. */
const PUBLIC: Record<string, string> = {
  "api/auth/[...nextauth]/route.ts": "the sign-in flow itself",
  "api/asafarim/session/route.ts": "sends a signed-out browser to sign-in (tested below)",
  "api/health/route.ts": "liveness for the OS, no documents",
  "robots.ts": "tells crawlers to stay out",
};
/** Server actions that need no permission: signing in and out. */
const PUBLIC_ACTIONS = new Set(["signInAction", "signOutAction"]);

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((f) => String(f).split(path.sep).join("/"))
    .sort();
}
const files = filesUnder(APP);
const pages = files.filter((f) => /(^|\/)page\.tsx$/.test(f));
const handlers = files.filter((f) => /(^|\/)route\.ts$/.test(f) || f === "robots.ts");
const actionFiles = files.filter(
  (f) => /\.tsx?$/.test(f) && /^\s*["']use server["']/.test(readFileSync(path.join(APP, f), "utf8")),
);

// What a request sees: who is signed in, and what core-api says about them.
const who = vi.hoisted(() => ({ subject: undefined as string | undefined, permissions: [] as string[] }));
const sourceSpy = vi.hoisted(() => ({ calls: 0, source: undefined as unknown }));

class Interrupt extends Error {
  constructor(
    readonly kind: "unauthorized" | "forbidden" | "redirect",
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
  redirect: (to: string) => {
    throw new Interrupt("redirect", to);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (who.subject ? { user: { id: who.subject, name: who.subject } } : null),
  signIn: vi.fn(),
  signOut: vi.fn(),
  // Auth.js itself is a dependency; the stand-in only has to answer like a sign-in page would.
  handlers: { GET: async () => new Response("sign in"), POST: async () => new Response("sign in") },
}));
vi.mock("@/lib/platform", () => ({
  getPlatform: () => ({
    config: { getString: (k: string) => (k === "source.repo" ? "example-org/handbook" : "main") },
    access: {
      access: async () => ({ state: "active", roles: [], permissions: who.permissions }),
      require: async (_session: unknown, permission: string) => {
        if (!who.permissions.includes(permission)) throw new ForbiddenError(permission);
      },
      launcher: async () => [],
      mintToken: async () => ({ token: "t", expiresIn: 60 }),
    },
  }),
}));
vi.mock("@/lib/source", async (importOriginal) => {
  const real = await importOriginal<typeof realSource>();
  return {
    ...real,
    getSource: () => {
      sourceSpy.calls++;
      return sourceSpy.source as DocSource;
    },
  };
});

const fixtures = createSource(createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures")));
const MARKER = "docs-fixture-marker";

async function load<T>(file: string): Promise<T> {
  return (await import(path.join(APP, file))) as T;
}

/** Call every HTTP method a route file exports, with params made up from its folder names. */
async function callRoute(file: string): Promise<{ method: string; res: Response }[]> {
  if (file === "robots.ts") {
    const { default: robots } = await load<{ default: () => unknown }>(file);
    return [{ method: "GET", res: Response.json(robots()) }];
  }
  const mod = await load<Record<string, unknown>>(file);
  const params: Record<string, string | string[]> = {};
  for (const m of file.matchAll(/\[(\.\.\.)?([^\]]+)\]/g)) params[m[2]!] = m[1] ? ["images", "diagram.svg"] : "x";
  const out: { method: string; res: Response }[] = [];
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
    const fn = mod[method];
    if (typeof fn !== "function") continue;
    const req = new Request(`http://docs.test/${file.replace(/\/?route\.ts$/, "")}`, { method });
    out.push({
      method,
      res: await (fn as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params) }),
    });
  }
  return out;
}

async function renderPage(file: string, search: Record<string, string> = {}) {
  const { default: Page } = await load<{ default: (p: unknown) => Promise<unknown> }>(file);
  return Page({ searchParams: Promise.resolve(search), params: Promise.resolve({}) });
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

/** Every string in a rendered element tree, and every `nodes` prop (the sidebar). */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return;
  visit(props);
  walk(props.children, visit);
}

beforeEach(() => {
  who.subject = undefined;
  who.permissions = [];
  sourceSpy.calls = 0;
  sourceSpy.source = fixtures;
});
afterEach(() => fixtures.refresh());

describe("the routes on disk (#79)", () => {
  it("finds the app's pages, route handlers and server actions", () => {
    expect(pages).toContain("page.tsx");
    expect(handlers).toContain("api/files/[...path]/route.ts");
    expect(actionFiles).toContain("actions.ts");
    for (const file of Object.keys(PUBLIC)) expect(handlers, `${file} is listed as public but gone`).toContain(file);
  });
});

describe("not signed in (#79)", () => {
  it.each(pages)("page %s is the 401 sign-in page", async (file) => {
    expect((await interruptOf(() => renderPage(file)))?.kind).toBe("unauthorized");
    expect(sourceSpy.calls).toBe(0);
  });

  it.each(handlers.filter((f) => !(f in PUBLIC)))("route %s answers 401 or the sign-in redirect", async (file) => {
    const answers = await callRoute(file);
    expect(answers.length).toBeGreaterThan(0);
    for (const { method, res } of answers) {
      expect([401, 302, 303, 307], `${method} ${file}`).toContain(res.status);
      expect(await res.text()).not.toContain(MARKER);
    }
    expect(sourceSpy.calls).toBe(0);
  });

  it.each(Object.keys(PUBLIC))("public route %s never returns document text", async (file) => {
    for (const { method, res } of await callRoute(file)) {
      expect(res.status, `${method} ${file}`).toBeLessThan(500);
      expect(await res.text()).not.toContain(MARKER);
    }
    expect(sourceSpy.calls).toBe(0);
  });

  it("the session route sends the browser to sign-in", async () => {
    const { res } = (await callRoute("api/asafarim/session/route.ts"))[0]!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/api\/auth\/signin\?/);
  });

  it.each(actionFiles)("server actions in %s read nothing without docs.read", async (file) => {
    const mod = await load<Record<string, unknown>>(file);
    const gated = Object.entries(mod).filter(([name, fn]) => typeof fn === "function" && !PUBLIC_ACTIONS.has(name));
    expect(gated.map(([name]) => name)).toContain("refreshAction");
    for (const [name, fn] of gated) {
      const form = new FormData();
      form.set("doc", "index.md");
      const refresh = vi.spyOn(fixtures, "refresh");
      const stop = await interruptOf(() => (fn as (f: FormData) => Promise<unknown>)(form));
      // refreshAction keeps sending the browser back to the page, which then asks to sign in.
      expect(stop?.kind === "redirect" || stop?.kind === "unauthorized", name).toBe(true);
      expect(sourceSpy.calls, name).toBe(0);
      expect(refresh, name).not.toHaveBeenCalled();
      refresh.mockRestore();
    }
  });
});

describe("signed in as dev-member, without docs.owner (#79)", () => {
  beforeEach(() => {
    who.subject = "dev-member";
  });

  it.each(pages)("page %s is the 403 page, with no tree, titles or counts", async (file) => {
    expect((await interruptOf(() => renderPage(file)))?.kind).toBe("forbidden");
    expect(sourceSpy.calls).toBe(0);
  });

  it("the 403 page names docs.read and shows nothing of the documents", async () => {
    const { default: Forbidden } = await load<{ default: () => unknown }>("forbidden.tsx");
    const text: string[] = [];
    walk(Forbidden(), (p) => {
      if (typeof p.children === "string") text.push(p.children);
      if (Array.isArray(p.children)) text.push(...p.children.filter((c): c is string => typeof c === "string"));
      expect(p).not.toHaveProperty("nodes");
    });
    expect(text.join(" ")).toContain("docs.read");
  });

  it.each(handlers.filter((f) => !(f in PUBLIC)))("route %s answers 403 naming docs.read", async (file) => {
    for (const { method, res } of await callRoute(file)) {
      expect(res.status, `${method} ${file}`).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden", permission: "docs.read" });
    }
    expect(sourceSpy.calls).toBe(0);
  });
});

describe("signed in with docs.owner (#79)", () => {
  beforeEach(() => {
    who.subject = "owner";
    who.permissions = ["docs.read"];
  });

  it("the page loads the document tree", async () => {
    const trees: unknown[] = [];
    walk(await renderPage("page.tsx", { doc: "index.md" }), (p) => {
      if (Array.isArray(p.nodes)) trees.push(p.nodes);
    });
    expect(trees.length).toBeGreaterThan(0);
    expect(JSON.stringify(trees[0])).toContain("getting-started.md");
  });

  it("the image route serves the fixture image", async () => {
    const { res } = (await callRoute("api/files/[...path]/route.ts"))[0]!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });
});
