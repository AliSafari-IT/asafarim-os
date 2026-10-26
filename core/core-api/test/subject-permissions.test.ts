/**
 * `GET /registry/v1/subjects/<sub>/permissions` (Flow) over HTTP, with a stub of the core database:
 * real Ed25519 credentials and signatures, the registry's own checks, and the handler's routing and
 * logging. What only Postgres can show (deprecated permissions, the SQL's namespace join) is in
 * `test/registry.integration.test.ts`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ed25519Scheme, signRequest } from "../src/credentials.ts";
import { createRegistry } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const notes = ed25519Scheme.issue("notes");
const tasks = ed25519Scheme.issue("tasks");
const gone = ed25519Scheme.issue("gone");

/** The core database, as far as this route reads it. */
const db = {
  apps: new Map<string, string>(),
  credentials: new Map<string, { app_id: string; scheme: string; verifier: string; revoked: boolean }>(),
  nonces: new Set<string>(),
  /** subject → app → the live permissions its roles carry there. */
  grants: new Map<string, Record<string, string[]>>(),
  /** Every app id the permission query was asked for. */
  permissionQueries: [] as string[],
};

const rows = <T>(r: T[]) => ({ rows: r, rowCount: r.length });

const pool = {
  async query(sql: string, params: unknown[] = []) {
    const [a, b] = params as string[];
    if (sql.startsWith("SELECT app_id FROM app_credentials")) {
      const c = db.credentials.get(a!);
      return rows(c ? [{ app_id: c.app_id }] : []);
    }
    if (sql.startsWith("SELECT state FROM apps")) {
      const state = db.apps.get(a!);
      return rows(state ? [{ state }] : []);
    }
    if (sql.startsWith("SELECT scheme, verifier FROM app_credentials")) {
      const c = db.credentials.get(a!);
      return rows(c && c.app_id === b && !c.revoked ? [c] : []);
    }
    if (sql.startsWith("DELETE FROM registry_nonces")) return rows([]);
    if (sql.startsWith("INSERT INTO registry_nonces")) {
      if (db.nonces.has(a!)) return rows([]);
      db.nonces.add(a!);
      return rows([{}]);
    }
    if (sql.includes("SELECT g.role_key AS key")) return rows([]);
    if (sql.includes("SELECT DISTINCT p.key")) {
      db.permissionQueries.push(b!);
      return rows((db.grants.get(a!)?.[b!] ?? []).map((key) => ({ key })));
    }
    throw new Error(`unexpected query: ${sql}`);
  },
} as unknown as pg.Pool;

const logs: Record<string, unknown>[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  const registry = createRegistry({
    pool,
    provisioner: async () => {
      throw new Error("not used");
    },
    appDatabaseHost: { host: "127.0.0.1", port: 5432 },
  });
  server = createServer(
    createHandler({ registry, pool, adminToken: "t".repeat(40), log: (l) => logs.push(l as never) }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
  db.apps = new Map([
    ["notes", "active"],
    ["tasks", "inactive"],
    ["gone", "removed"],
  ]);
  db.credentials = new Map(
    [notes, tasks, gone].map((c) => [
      c.keyId,
      { app_id: c.keyId.split(".")[0]!, scheme: c.scheme, verifier: c.verifier, revoked: c === gone },
    ]),
  );
  db.grants = new Map<string, Record<string, string[]>>([
    ["user-1", { notes: ["notes.notes.read", "notes.notes.write"], tasks: ["tasks.tasks.close"] }],
    ["user@example.test:1", { notes: ["notes.notes.read"] }],
  ]);
  db.nonces = new Set();
  db.permissionQueries = [];
  logs.length = 0;
});

const pathOf = (encodedSub: string) => `/registry/v1/subjects/${encodedSub}/permissions`;

async function ask(
  encodedSub: string,
  opts: { credential?: string; signedPath?: string; method?: string; headers?: Record<string, string> } = {},
) {
  const path = pathOf(encodedSub);
  const headers =
    opts.headers ??
    signRequest({
      credential: opts.credential ?? notes.secret,
      method: opts.method ?? "GET",
      path: opts.signedPath ?? path,
    });
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /registry/v1/subjects/<sub>/permissions (Flow)", () => {
  it("answers the calling app's own permissions the subject holds, sorted", async () => {
    expect(await ask("user-1")).toEqual({
      status: 200,
      body: { sub: "user-1", app: "notes", permissions: ["notes.notes.read", "notes.notes.write"] },
    });
  });

  it("is scoped to the app that signed: another app's credential gets only its own namespace", async () => {
    const r = await ask("user-1", { credential: tasks.secret });
    // An inactive app may still ask: its event handlers run whatever the gateway serves.
    expect(r).toEqual({ status: 200, body: { sub: "user-1", app: "tasks", permissions: ["tasks.tasks.close"] } });
    expect(db.permissionQueries).toEqual(["tasks"]);
  });

  it("an unknown subject, or one with no grants here, gets an empty list, never a 404", async () => {
    expect(await ask("nobody")).toEqual({ status: 200, body: { sub: "nobody", app: "notes", permissions: [] } });
    // user-2 holds notes permissions only: tasks learns nothing about them.
    db.grants.set("user-2", { notes: ["notes.notes.read"] });
    expect(await ask("user-2", { credential: tasks.secret })).toEqual({
      status: 200,
      body: { sub: "user-2", app: "tasks", permissions: [] },
    });
  });

  it("decodes a percent-encoded subject; the signature covers the encoded path", async () => {
    const enc = encodeURIComponent("user@example.test:1");
    expect(await ask(enc)).toEqual({
      status: 200,
      body: { sub: "user@example.test:1", app: "notes", permissions: ["notes.notes.read"] },
    });
  });

  it("a bad subject is a 400, before any lookup", async () => {
    for (const bad of ["", "a%2Fb", "a%20b", "%E0%A4%A", "x".repeat(129)]) {
      const r = await ask(bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.error, bad).toBe("bad_request");
    }
    expect(db.permissionQueries).toEqual([]);
    expect(db.nonces.size).toBe(0); // refused before the signature check: no nonce burnt
  });

  it("the signature is bound to the subject, the method and the credential", async () => {
    expect((await ask("user-2", { signedPath: pathOf("user-1") })).body.error).toBe("bad_signature");
    expect((await ask("user-1", { method: "POST" })).body.error).toBe("bad_signature");
    const forged = { ...signRequest({ credential: tasks.secret, method: "GET", path: pathOf("user-1") }) };
    forged["x-asafarim-key-id"] = notes.keyId; // tasks' signature presented as notes' key
    expect((await ask("user-1", { headers: forged })).body.error).toBe("bad_signature");
    expect(db.permissionQueries).toEqual([]);
  });

  it("missing headers, an unknown key, a replay and an expired timestamp are refused like the other registry calls", async () => {
    expect(await ask("user-1", { headers: {} })).toMatchObject({ status: 401, body: { error: "missing_signature" } });

    const unknown = ed25519Scheme.issue("notes");
    expect(await ask("user-1", { credential: unknown.secret })).toMatchObject({
      status: 401,
      body: { error: "bad_signature" },
    });

    const headers = signRequest({ credential: notes.secret, method: "GET", path: pathOf("user-1") });
    expect((await ask("user-1", { headers })).status).toBe(200);
    expect(await ask("user-1", { headers })).toMatchObject({ status: 401, body: { error: "replayed_signature" } });

    const old = signRequest({
      credential: notes.secret,
      method: "GET",
      path: pathOf("user-1"),
      now: new Date(Date.now() - 120_000),
    });
    expect(await ask("user-1", { headers: old })).toMatchObject({ status: 401, body: { error: "expired_signature" } });
  });

  it("a removed app is unknown_app, and a revoked credential of a live app is bad_signature", async () => {
    expect(await ask("user-1", { credential: gone.secret })).toMatchObject({
      status: 403,
      body: { error: "unknown_app" },
    });
    db.credentials.get(notes.keyId)!.revoked = true;
    expect(await ask("user-1")).toMatchObject({ status: 401, body: { error: "bad_signature" } });
  });

  it("never logs the subject: a refusal logs the route pattern", async () => {
    await ask("secret-person", { signedPath: pathOf("someone-else") });
    await ask("a%20b");
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("person");
    expect(logs[0]).toMatchObject({ path: "/registry/v1/subjects/:sub/permissions", error: "bad_signature" });
  });
});
