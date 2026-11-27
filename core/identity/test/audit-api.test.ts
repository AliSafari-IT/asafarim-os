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
import type {
  AuditCounts,
  AuditEntry,
  AuditSearch,
  AuditSearchRow,
  DirectoryEntry,
  DirectoryProfile,
  DirectorySearch,
  Principal,
  ReactivateOutcome,
  SuspendOutcome,
} from "../src/store.ts";
import { DirectoryCursorError } from "../src/store.ts";

const ISSUER = "https://id.example.test";
const ADMIN = "0190b6c4-0000-7000-8000-000000000001";
const MEMBER = "0190b6c4-0000-7000-8000-000000000002";
const REVOKED_ADMIN = "0190b6c4-0000-7000-8000-000000000003";

class Reader implements AuditReader {
  readonly searches: AuditSearch[] = [];
  readonly audits: AuditEntry[] = [];
  counts: AuditCounts = { perDay: [], pendingRequests: 0, activeConnections: 0, publicAdmissions: 0 };
  sinceAsked: Date | undefined;
  async principal(id: string): Promise<Principal | null> {
    if (id === ADMIN)
      return {
        id,
        isAdmin: true,
        connection: "active",
        label: "ali@example.test",
        methods: [],
        admittedClients: [],
        emailVerified: false,
      };
    if (id === MEMBER)
      return {
        id,
        isAdmin: false,
        connection: "active",
        label: "m@example.test",
        methods: [],
        admittedClients: [],
        emailVerified: false,
      };
    if (id === REVOKED_ADMIN)
      return {
        id,
        isAdmin: true,
        connection: "revoked",
        label: "r@example.test",
        methods: [],
        admittedClients: [],
        emailVerified: false,
      };
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
  readonly directorySearches: DirectorySearch[] = [];
  async directory(f: DirectorySearch): Promise<{ users: DirectoryEntry[]; next: string | null }> {
    this.directorySearches.push(f);
    if (f.after === "bad-cursor") throw new DirectoryCursorError();
    return { users: [ENTRY], next: "cursor-2" };
  }
  suspendOutcome: SuspendOutcome = "suspended";
  reactivateOutcome: ReactivateOutcome = "reconnected";
  readonly actions: string[] = [];
  async adminSuspend(principalId: string, actorId: string): Promise<SuspendOutcome> {
    this.actions.push(`suspend ${principalId} by ${actorId}`);
    return this.suspendOutcome;
  }
  async adminReactivate(principalId: string, actorId: string): Promise<ReactivateOutcome> {
    this.actions.push(`reactivate ${principalId} by ${actorId}`);
    return this.reactivateOutcome;
  }
  async directoryProfile(id: string): Promise<DirectoryProfile | null> {
    if (id !== MEMBER) return null;
    return {
      ...ENTRY,
      identities: [
        {
          method: "email",
          identifier: "m@example.test",
          verifiedAt: new Date("2026-10-01T00:00:00Z"),
          lastLoginAt: null,
          createdAt: new Date("2026-10-01T00:00:00Z"),
        },
      ],
      passkeys: 1,
      connection: {
        status: "active",
        source: "admin",
        grantedAt: new Date("2026-10-02T00:00:00Z"),
        grantedBy: ADMIN,
        revokedAt: null,
        revokedBy: null,
      },
      admissions: [],
      pendingRequest: null,
    };
  }
}

const ENTRY: DirectoryEntry = {
  id: MEMBER,
  label: "m@example.test",
  email: "m@example.test",
  emailVerified: true,
  state: "active",
  scope: "global",
  admittedClients: [],
  isAdmin: false,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  lastLoginAt: new Date("2026-10-25T09:00:00Z"),
};

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
  const ended: string[] = [];
  const api = createAuditApi({
    issuer: ISSUER,
    jwks: { keys: [signingJwk] },
    readers: ["core-admin"],
    store,
    endSessions: async (id) => (ended.push(id), 2),
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
  return { store, get, lines, ended };
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
      publicAdmissions: 0,
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
      publicAdmissions: 0,
    });
    expect((await get("/admin/v1/audit/summary", await adminToken())).body.days).toBe(14);
    expect((await get("/admin/v1/audit/summary?days=91", await adminToken())).status).toBe(400);
  });
});

describe("the people directory (GET /admin/v1/users)", () => {
  const admin = () => sign({ sub: ADMIN, aud: "core-admin" });

  it("lists a page for an identity admin, uncached, with dates as ISO strings and an opaque cursor", async () => {
    const { get, store } = setup();
    const r = await get(
      "/admin/v1/users?q=m%40example&state=active&scope=global&limit=10&after=abc_DEF-1",
      await admin(),
    );
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(store.directorySearches).toEqual([
      { q: "m@example", state: "active", scope: "global", limit: 10, after: "abc_DEF-1" },
    ]);
    expect(r.body).toEqual({
      users: [
        {
          id: MEMBER,
          label: "m@example.test",
          email: "m@example.test",
          emailVerified: true,
          state: "active",
          scope: "global",
          admittedClients: [],
          isAdmin: false,
          createdAt: "2026-10-01T00:00:00.000Z",
          lastLoginAt: "2026-10-25T09:00:00.000Z",
        },
      ],
      next: "cursor-2",
    });
  });

  it("reveals nothing without a token (401) or to someone who isn't an active identity admin (403)", async () => {
    const { get, store } = setup();
    expect((await get("/admin/v1/users")).status).toBe(401);
    expect((await get(`/admin/v1/users/${MEMBER}`)).status).toBe(401);
    const member = await sign({ sub: MEMBER, aud: "core-admin" });
    const r = await get("/admin/v1/users", member);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("m@example.test");
    expect((await get(`/admin/v1/users/${MEMBER}`, await sign({ sub: REVOKED_ADMIN, aud: "core-admin" }))).status).toBe(
      403,
    );
    expect(store.directorySearches).toHaveLength(0);
  });

  it("refuses malformed filters with 400 before reading anything", async () => {
    const { get, store } = setup();
    const token = await admin();
    for (const q of [
      "state=deleted",
      "scope=everything",
      "limit=0",
      "limit=101",
      `q=${"x".repeat(201)}`,
      "q=a%0Ab",
      "after=not%20a%20cursor",
    ]) {
      expect((await get(`/admin/v1/users?${q}`, token)).status, q).toBe(400);
    }
    expect(store.directorySearches).toHaveLength(0);
    expect((await get("/admin/v1/users?after=bad-cursor", token)).status).toBe(400);
    expect((await get("/admin/v1/users", token, "POST")).status).toBe(405);
  });

  it("one person by id: their identities, connection and admissions; 404 for anyone else", async () => {
    const { get } = setup();
    const token = await admin();
    const r = await get(`/admin/v1/users/${MEMBER}`, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: MEMBER,
      identities: [{ method: "email", identifier: "m@example.test", verifiedAt: "2026-10-01T00:00:00.000Z" }],
      passkeys: 1,
      connection: { status: "active", source: "admin", grantedBy: ADMIN, grantedAt: "2026-10-02T00:00:00.000Z" },
      admissions: [],
      pendingRequest: null,
    });
    expect((await get("/admin/v1/users/0190b6c4-0000-7000-8000-00000000ffff", token)).status).toBe(404);
    expect((await get("/admin/v1/users/not-an-id", token)).status).toBe(404);
  });
});

describe("account actions (POST /admin/v1/users/<id>/suspend|reactivate)", () => {
  const admin = () => sign({ sub: ADMIN, aud: "core-admin" });

  it("an identity admin suspends someone: their sessions end, and the fresh entry comes back", async () => {
    const { get, store, ended } = setup();
    const r = await get(`/admin/v1/users/${MEMBER}/suspend`, await admin(), "POST");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toMatchObject({ outcome: "suspended", changed: true, sessionsEnded: 2, user: { id: MEMBER } });
    expect(store.actions).toEqual([`suspend ${MEMBER} by ${ADMIN}`]);
    expect(ended).toEqual([MEMBER]);
  });

  it("a retry changes nothing and ends no sessions", async () => {
    const { get, store, ended } = setup();
    store.suspendOutcome = "already";
    const r = await get(`/admin/v1/users/${MEMBER}/suspend`, await admin(), "POST");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: "already", changed: false, sessionsEnded: 0 });
    expect(ended).toEqual([]);
  });

  it("refuses self-suspension, the last identity admin and an account with no access (409), an unknown one (404)", async () => {
    for (const [outcome, status] of [
      ["self", 409],
      ["last_admin", 409],
      ["no_access", 409],
      ["unknown", 404],
    ] as const) {
      const { get, store, ended } = setup();
      store.suspendOutcome = outcome;
      const r = await get(`/admin/v1/users/${MEMBER}/suspend`, await admin(), "POST");
      expect(r.status, outcome).toBe(status);
      expect(r.body.error, outcome).toBe(outcome);
      expect(ended).toEqual([]);
    }
  });

  it("reactivates: reconnected or admissions restored; not suspended is a harmless retry", async () => {
    for (const [outcome, changed] of [
      ["reconnected", true],
      ["admissions_restored", true],
      ["not_suspended", false],
    ] as const) {
      const { get, store } = setup();
      store.reactivateOutcome = outcome;
      const r = await get(`/admin/v1/users/${MEMBER}/reactivate`, await admin(), "POST");
      expect(r.status, outcome).toBe(200);
      expect(r.body).toMatchObject({ outcome, changed });
    }
  });

  it("only an active identity admin, only POST, only an account id", async () => {
    const { get, store } = setup();
    expect((await get(`/admin/v1/users/${MEMBER}/suspend`, undefined, "POST")).status).toBe(401);
    expect(
      (await get(`/admin/v1/users/${MEMBER}/suspend`, await sign({ sub: MEMBER, aud: "core-admin" }), "POST")).status,
    ).toBe(403);
    expect((await get(`/admin/v1/users/${MEMBER}/suspend`, await admin(), "GET")).status).toBe(405);
    expect((await get("/admin/v1/users/not-an-id/suspend", await admin(), "POST")).status).toBe(404);
    expect((await get(`/admin/v1/users/${MEMBER}/delete`, await admin(), "POST")).handled).toBe(false);
    expect(store.actions).toEqual([]);
  });
});
