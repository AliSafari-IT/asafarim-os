/**
 * The sign-in trail for the Admin console (src/audit-api.ts): who may read it (an identity admin's ID
 * token, issued to a reader client, signed by identity), what each filter accepts, and the summary's days.
 * The Postgres queries behind it are in audit-api.integration.test.ts.
 */
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuditApi, type AuditReader } from "../src/audit-api.ts";
import type { HttpContext } from "../src/http.ts";
import { createLogger } from "../src/log.ts";
import type { AuditCounts, AuditEntry, AuditSearch, AuditSearchRow, Principal } from "../src/store.ts";

const ISSUER = "https://id.example.test";
const ADMIN = "0190b6c4-0000-7000-8000-000000000001";
const MEMBER = "0190b6c4-0000-7000-8000-000000000002";
const REVOKED_ADMIN = "0190b6c4-0000-7000-8000-000000000003";

class Reader implements AuditReader {
  readonly searches: AuditSearch[] = [];
  readonly audits: AuditEntry[] = [];
  counts: AuditCounts = { perDay: [], pendingRequests: 0, activeConnections: 0 };
  sinceAsked: Date | undefined;
  async principal(id: string): Promise<Principal | null> {
    if (id === ADMIN) return { id, isAdmin: true, connection: "active", label: "ali@example.test", methods: [] };
    if (id === MEMBER) return { id, isAdmin: false, connection: "active", label: "m@example.test", methods: [] };
    if (id === REVOKED_ADMIN) return { id, isAdmin: true, connection: "revoked", label: "r@example.test", methods: [] };
    return null;
  }
  async searchAudit(f: AuditSearch): Promise<{ events: AuditSearchRow[]; next: number | null }> {
    this.searches.push(f);
    const row: AuditSearchRow = {
      id: 7,
      at: new Date("2026-10-26T10:00:00Z"),
      event: "login.granted",
      method: "email",
      principalId: ADMIN,
      actorId: null,
      label: "ali@example.test",
      actorLabel: null,
      subjectHandle: null,
      ipHandle: "ip-handle-1234",
      detail: { target: "oidc" },
    };
    return { events: [row], next: null };
  }
  async auditCounts(since: Date): Promise<AuditCounts> {
    this.sinceAsked = since;
    return this.counts;
  }
  async audit(entry: AuditEntry) {
    this.audits.push(entry);
  }
}

let signingJwk: JWK;
let sign: (claims: Record<string, unknown>, opts?: { iss?: string; exp?: string }) => Promise<string>;
let otherKeySign: (sub: string) => Promise<string>;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  signingJwk = { ...(await exportJWK(privateKey)), kid: "k1" };
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(opts.iss ?? ISSUER)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "1h")
      .sign(privateKey);
  const other = await generateKeyPair("ES256");
  otherKeySign = (sub) =>
    new SignJWT({ sub, aud: "core-admin" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(ISSUER)
      .setExpirationTime("1h")
      .sign(other.privateKey);
});

function setup(now = new Date("2026-10-26T12:00:00Z")) {
  const store = new Reader();
  const lines: string[] = [];
  const api = createAuditApi({
    issuer: ISSUER,
    jwks: { keys: [signingJwk] },
    readers: ["core-admin"],
    store,
    log: createLogger((l) => lines.push(l)),
    now: () => now,
  });
  async function get(url: string, token?: string, method = "GET") {
    const u = new URL(url, ISSUER);
    const headers: Record<string, string> = {};
    const ctx = {
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      status: 404,
      type: "",
      body: undefined as unknown,
      get: (f: string) => (f.toLowerCase() === "authorization" && token ? `Bearer ${token}` : ""),
      set: (f: string, v: string) => {
        headers[f.toLowerCase()] = v;
      },
    } as unknown as HttpContext;
    const handled = await api.handle(ctx);
    return { handled, status: ctx.status, body: ctx.body as Record<string, unknown>, headers };
  }
  return { store, get, lines };
}

const adminToken = () => sign({ sub: ADMIN, aud: "core-admin" });

describe("who may read the trail", () => {
  it("an identity admin's ID token for the console reads it, uncached", async () => {
    const { get } = setup();
    const r = await get("/admin/v1/audit", await adminToken());
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body.events).toEqual([
      expect.objectContaining({ event: "login.granted", at: "2026-10-26T10:00:00.000Z" }),
    ]);
  });

  it("no token, a token signed by another key, another issuer, another client or an expired one: 401", async () => {
    const { get, lines } = setup();
    expect((await get("/admin/v1/audit")).status).toBe(401);
    expect((await get("/admin/v1/audit", await otherKeySign(ADMIN))).status).toBe(401);
    expect(
      (await get("/admin/v1/audit", await sign({ sub: ADMIN, aud: "core-admin" }, { iss: "https://evil.test" })))
        .status,
    ).toBe(401);
    expect((await get("/admin/v1/audit", await sign({ sub: ADMIN, aud: "notes" }))).status).toBe(401);
    expect((await get("/admin/v1/audit", await sign({ sub: ADMIN, aud: "core-admin" }, { exp: "-1m" }))).status).toBe(
      401,
    );
    expect(lines.join("\n")).not.toContain("eyJ"); // never a token in the logs
  });

  it("a signed-in person who isn't an active identity admin: 403, and the refusal is audited", async () => {
    const { get, store } = setup();
    expect((await get("/admin/v1/audit", await sign({ sub: MEMBER, aud: "core-admin" }))).status).toBe(403);
    expect((await get("/admin/v1/audit/summary", await sign({ sub: REVOKED_ADMIN, aud: "core-admin" }))).status).toBe(
      403,
    );
    expect((await get("/admin/v1/audit", await sign({ sub: "not-a-uuid", aud: "core-admin" }))).status).toBe(403);
    expect(store.audits).toEqual([
      { event: "admin.denied", principalId: MEMBER, detail: { via: "audit_api" } },
      { event: "admin.denied", principalId: REVOKED_ADMIN, detail: { via: "audit_api" } },
    ]);
    expect(store.searches).toEqual([]);
  });

  it("only GET, and only its two paths", async () => {
    const { get } = setup();
    expect((await get("/admin/v1/audit", await adminToken(), "POST")).status).toBe(405);
    expect((await get("/admin/v1/other", await adminToken())).handled).toBe(false);
    expect((await get("/admin", await adminToken())).handled).toBe(false);
  });
});

describe("filters", () => {
  it("passes valid filters through: an event or a kind, method, person, handle, time, paging", async () => {
    const { get, store } = setup();
    const t = await adminToken();
    await get(
      `/admin/v1/audit?event=login.granted&method=google&principal=${ADMIN.toUpperCase()}&handle=abcdefgh12&since=2026-10-01&until=2026-10-27T00:00:00Z&before=99&limit=25`,
      t,
    );
    await get("/admin/v1/audit?event=otp.,login.not_authorized", t);
    expect(store.searches).toEqual([
      {
        events: ["login.granted"],
        method: "google",
        principalId: ADMIN,
        handle: "abcdefgh12",
        since: new Date("2026-10-01"),
        until: new Date("2026-10-27T00:00:00Z"),
        before: 99,
        limit: 25,
      },
      { events: ["otp.", "login.not_authorized"] },
    ]);
  });

  it("refuses malformed filters with 400 before reading anything", async () => {
    const { get, store } = setup();
    const t = await adminToken();
    for (const bad of [
      "event=LOGIN",
      "event=login.granted;drop",
      "event=a,,b",
      `event=${Array(17).fill("otp.").join(",")}`,
      "method=e-mail",
      "principal=123",
      "handle=short",
      "since=yesterday",
      "until=2026-13-45",
      "limit=500",
      "before=-1",
    ]) {
      expect((await get(`/admin/v1/audit?${bad}`, t)).status, bad).toBe(400);
    }
    expect(store.searches).toEqual([]);
  });
});

describe("summary", () => {
  it("one entry per UTC day (empty days too), counts per event, open requests and connections", async () => {
    const { get, store } = setup(new Date("2026-10-26T23:30:00Z"));
    store.counts = {
      perDay: [
        { day: "2026-10-26", event: "login.granted", n: 3 },
        { day: "2026-10-26", event: "otp.verify_failed", n: 2 },
        { day: "2026-10-24", event: "login.granted", n: 1 },
        { day: "2026-09-01", event: "login.granted", n: 9 }, // outside the window: ignored
      ],
      pendingRequests: 2,
      activeConnections: 5,
    };
    const r = await get("/admin/v1/audit/summary?days=3", await adminToken());
    expect(store.sinceAsked).toEqual(new Date("2026-10-24T00:00:00Z"));
    expect(r.body).toEqual({
      days: 3,
      since: "2026-10-24T00:00:00.000Z",
      total: 6,
      byDay: [
        { day: "2026-10-24", total: 1, events: { "login.granted": 1 } },
        { day: "2026-10-25", total: 0, events: {} },
        { day: "2026-10-26", total: 5, events: { "login.granted": 3, "otp.verify_failed": 2 } },
      ],
      byEvent: { "login.granted": 4, "otp.verify_failed": 2 },
      pendingRequests: 2,
      activeConnections: 5,
    });
    expect((await get("/admin/v1/audit/summary", await adminToken())).body.days).toBe(14);
    expect((await get("/admin/v1/audit/summary?days=91", await adminToken())).status).toBe(400);
  });
});
