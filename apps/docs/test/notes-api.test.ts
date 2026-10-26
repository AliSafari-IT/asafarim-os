/**
 * The notes API (#81): docs.read first, docs.notes.write for every change, and a person only ever
 * sees or changes their own notes. The store is the real one over a recording stand-in for Postgres
 * (test/fake-db.ts; the e2e run uses the app's real database).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ForbiddenError } from "@asafarim/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotesStore, type NotesStore } from "../lib/notes";
import { createFixtureBackend, createSource } from "../lib/source";
import { fakeDb, type FakeDb } from "./fake-db";

const who = vi.hoisted(() => ({ subject: undefined as string | undefined, permissions: [] as string[] }));
const db = vi.hoisted(() => ({ store: null as NotesStore | null }));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (who.subject ? { user: { id: who.subject } } : null),
}));
vi.mock("@/lib/platform", () => ({
  getPlatform: () => ({
    config: { getString: (k: string) => (k === "source.repo" ? "example-org/handbook" : "main") },
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
  getNotes: () => db.store,
}));

const ROADMAP = "ventures/demo-app/roadmap/roadmap.md";
const roadmap = readFileSync(path.resolve(import.meta.dirname, "../fixtures", ROADMAP), "utf8");

const collection = () => import("../app/api/notes/route");
const item = () => import("../app/api/notes/[id]/route");
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (method: string, body: unknown, url = "http://docs.test/api/notes") =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const create = async (body: unknown) => (await collection()).POST(jsonReq("POST", body));
const valid = { docPath: ROADMAP, headingId: "milestones", quote: "Ship the  beta", body: "Ask **Team B** about it." };

let pool: FakeDb;
beforeEach(() => {
  who.subject = "owner";
  who.permissions = ["docs.read", "docs.notes.write"];
  pool = fakeDb();
  db.store = createNotesStore(pool.pool);
});

describe("who may use the notes (#81)", () => {
  it("signed out: 401 on every method", async () => {
    who.subject = undefined;
    expect((await (await collection()).GET(new Request("http://docs.test/api/notes"))).status).toBe(401);
    expect((await create(valid)).status).toBe(401);
    expect((await (await item()).DELETE(new Request("http://docs.test/"), params("1"))).status).toBe(401);
  });

  it("docs.read without docs.notes.write: reads, but every change is a 403 naming docs.notes.write", async () => {
    who.permissions = ["docs.read"];
    expect((await (await collection()).GET(new Request("http://docs.test/api/notes"))).status).toBe(200);
    for (const res of [
      await create(valid),
      await (await item()).PATCH(jsonReq("PATCH", { body: "x" }), params("1")),
      await (await item()).DELETE(new Request("http://docs.test/"), params("1")),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden", permission: "docs.notes.write" });
    }
    expect(pool.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql))).toEqual([]);
  });

  it("no database: 503, and nothing else breaks", async () => {
    db.store = null;
    const res = await (await collection()).GET(new Request("http://docs.test/api/notes"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "notes_unavailable" });
  });
});

describe("writing notes (#81)", () => {
  it("creates a note on the document's current version", async () => {
    const res = await create(valid);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { note } = await res.json();
    expect(note).toMatchObject({
      docPath: ROADMAP,
      headingId: "milestones",
      quote: "Ship the beta",
      body: "Ask **Team B** about it.",
      docSha: createHash("sha256").update(roadmap).digest("hex"),
      issueUrl: null,
    });
  });

  it("refuses a body that isn't JSON (a cross-site form can't send one)", async () => {
    const req = new Request("http://docs.test/api/notes", { method: "POST", body: "docPath=x" });
    expect((await (await collection()).POST(req)).status).toBe(415);
  });

  it.each([
    ["no body", { ...valid, body: "  " }],
    ["a body over 10 000 characters", { ...valid, body: "x".repeat(10_001) }],
    ["a quote over 1 000 characters", { ...valid, quote: "x".repeat(1001) }],
    ["a document outside the listing", { ...valid, docPath: "ventures/nowhere.md" }],
    ["a path past the root", { ...valid, docPath: "../outside.md" }],
    ["a heading the document doesn't have", { ...valid, headingId: "nope" }],
  ])("refuses %s with 422", async (_what, body) => {
    expect((await create(body)).status).toBe(422);
  });

  it("edits and deletes only the author's own notes; anyone else's is not found", async () => {
    const { note } = await (await create(valid)).json();
    const { PATCH, DELETE } = await item();

    who.subject = "someone-else";
    expect((await PATCH(jsonReq("PATCH", { body: "mine now" }), params(note.id))).status).toBe(404);
    expect((await DELETE(new Request("http://docs.test/"), params(note.id))).status).toBe(404);

    who.subject = "owner";
    const edited = await PATCH(jsonReq("PATCH", { body: "Asked: next week." }), params(note.id));
    expect(edited.status).toBe(200);
    expect((await edited.json()).note.body).toBe("Asked: next week.");
    expect((await DELETE(new Request("http://docs.test/"), params(note.id))).status).toBe(204);
    expect((await DELETE(new Request("http://docs.test/"), params(note.id))).status).toBe(404);
  });

  it("a malformed id is not found, without asking the database", async () => {
    const { PATCH } = await item();
    expect((await PATCH(jsonReq("PATCH", { body: "x" }), params("1 OR 1=1"))).status).toBe(404);
    expect(pool.statements.some((s) => s.params.includes("1 OR 1=1"))).toBe(false);
  });
});

describe("reading notes (#81)", () => {
  it("lists only the caller's own notes, for one document or all", async () => {
    await create(valid);
    who.subject = "someone-else";
    await create({ ...valid, body: "Not yours." });
    who.subject = "owner";
    const { GET } = await collection();
    const all = await (await GET(new Request("http://docs.test/api/notes"))).json();
    expect(all.notes.map((n: { body: string }) => n.body)).toEqual(["Ask **Team B** about it."]);
    const one = await (await GET(new Request(`http://docs.test/api/notes?doc=${encodeURIComponent(ROADMAP)}`))).json();
    expect(one.notes).toHaveLength(1);
    const none = await (await GET(new Request("http://docs.test/api/notes?doc=..%2Fx.md"))).json();
    expect(none.notes).toEqual([]);
  });

  it("every statement the store sends is scoped to the author", async () => {
    await create(valid);
    await (await collection()).GET(new Request("http://docs.test/api/notes"));
    await (await item()).PATCH(jsonReq("PATCH", { body: "x" }), params("1"));
    await (await item()).DELETE(new Request("http://docs.test/"), params("1"));
    // Not the app's own migration, the transactions or the outbox row (which carries the author in the event).
    const scoped = pool.statements.filter((s) => !/CREATE TABLE|^(BEGIN|COMMIT|ROLLBACK)$|asafarim_outbox/.test(s.sql));
    expect(scoped.length).toBe(5);
    for (const s of scoped) expect(s.params[0]).toBe("owner");
    for (const s of scoped.filter((x) => !x.sql.startsWith("INSERT"))) expect(s.sql).toMatch(/author = \$1/);
  });
});
