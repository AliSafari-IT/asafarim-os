/**
 * The SMS sign-in against real storage:
 *
 * - Redis (IDENTITY_TEST_REDIS_URL, as flow.integration.test.ts; this file uses logical DB 14 and
 *   flushes it): codes, rate limits, sessions, flows, ending provider sessions, and the whole OIDC
 *   round trip with the SMS method;
 * - Postgres (IDENTITY_TEST_DATABASE_URL, a server login that may CREATE DATABASE): the store and its
 *   migration, in a throwaway database dropped afterwards.
 *
 * Locally: `docker run -d -p 127.0.0.1:56390:6379 redis:7-alpine`, a Postgres 16, then
 * IDENTITY_TEST_REDIS_URL=redis://127.0.0.1:56390/15 IDENTITY_TEST_DATABASE_URL=postgres://… pnpm test.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { exportJWK, generateKeyPair } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisAuthSessions, RedisEphemeral, RedisLoginFlows } from "../src/auth-session.ts";
import { loadClients } from "../src/clients.ts";
import { createLogger } from "../src/log.ts";
import { OTP_TTL_SECONDS, RedisOtpChallenges, RedisRateLimiter } from "../src/otp.ts";
import { createProvider } from "../src/provider.ts";
import { KEY_PREFIX, endSessionsOfAccount, redisAdapterFactory } from "../src/redis-adapter.ts";
import { createSignIn } from "../src/sign-in.ts";
import { PgIdentityStore, PrincipalAccounts } from "../src/store.ts";
import { CapturingMailer, MemoryStore } from "./fakes.ts";

const REDIS_URL = process.env.IDENTITY_TEST_REDIS_URL;
const DATABASE_URL = process.env.IDENTITY_TEST_DATABASE_URL;
// CI must run these, never skip them silently.
if (process.env.CI && (!REDIS_URL || !DATABASE_URL)) {
  throw new Error("IDENTITY_TEST_REDIS_URL and IDENTITY_TEST_DATABASE_URL must be set in CI");
}

/** Logical DB 14: flow.integration.test.ts flushes 15 and may run at the same time. */
function redisDb14(url: string) {
  const u = new URL(url);
  u.pathname = "/14";
  return u.href;
}

const ADMIN = "ali@example.test";
const OTHER = "someone@example.test";
const PHONE = "+32470000002";

describe.skipIf(!REDIS_URL)("SMS sign-in storage in Redis", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(redisDb14(REDIS_URL!));
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis?.flushdb();
    await redis?.quit();
  });

  it("a challenge is single-use, expires, and is deleted after the last wrong try", async () => {
    const otp = new RedisOtpChallenges(redis);
    await otp.create("c1", "HASH");
    const stored = await redis.get(`${KEY_PREFIX}sms-otp:c1`);
    expect(stored).toBe(JSON.stringify({ hash: "HASH", attempts: 0 }));
    const ttl = await redis.ttl(`${KEY_PREFIX}sms-otp:c1`);
    expect(ttl).toBeGreaterThan(OTP_TTL_SECONDS - 5);
    expect(await otp.verify("c1", "HASH")).toBe("ok");
    expect(await otp.verify("c1", "HASH")).toBe("missing");

    await otp.create("c2", "HASH");
    for (let i = 0; i < 4; i++) expect(await otp.verify("c2", "WRONG")).toBe("wrong");
    // The wrong tries kept the original deadline.
    expect(await redis.ttl(`${KEY_PREFIX}sms-otp:c2`)).toBeGreaterThan(OTP_TTL_SECONDS - 5);
    expect(await otp.verify("c2", "WRONG")).toBe("exhausted");
    expect(await otp.verify("c2", "HASH")).toBe("missing");

    // Parallel guesses can't exceed the limit.
    await otp.create("c3", "HASH");
    const results = await Promise.all(Array.from({ length: 20 }, () => otp.verify("c3", "WRONG")));
    expect(results.filter((r) => r === "wrong")).toHaveLength(4);
    expect(results.filter((r) => r === "exhausted")).toHaveLength(1);
  });

  it("rate limits count per window, and a cooldown runs once", async () => {
    const limits = new RedisRateLimiter(redis);
    const limit = { max: 2, windowSeconds: 60 };
    expect((await limits.hit("t", "x", limit)).allowed).toBe(true);
    expect((await limits.hit("t", "x", limit)).allowed).toBe(true);
    const third = await limits.hit("t", "x", limit);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
    expect((await limits.hit("t", "y", limit)).allowed).toBe(true);
    expect(await limits.cooldown("c", "x", 60)).toBe(true);
    expect(await limits.cooldown("c", "x", 60)).toBe(false);
  });

  it("sessions are stored by hash, and revocation ends all of a principal's sessions", async () => {
    const sessions = new RedisAuthSessions(redis);
    const a = await sessions.create("p1");
    const b = await sessions.create("p1");
    const c = await sessions.create("p2");
    expect((await redis.keys(`${KEY_PREFIX}sms-session:*`)).some((k) => k.includes(a.token))).toBe(false);
    expect((await sessions.get(a.token))!.principalId).toBe("p1");
    await sessions.destroyAllFor("p1");
    expect(await sessions.get(a.token)).toBeNull();
    expect(await sessions.get(b.token)).toBeNull();
    expect((await sessions.get(c.token))!.principalId).toBe("p2");
  });

  it("a flow keeps its deadline when updated, and can't be resurrected once gone", async () => {
    const flows = new RedisLoginFlows(redis);
    const token = await flows.create({ csrf: "x", target: { kind: "home" } });
    await flows.update(token, {
      csrf: "x",
      target: { kind: "home" },
      via: "email",
      identifier: ADMIN,
      challengeId: "c",
    });
    expect((await flows.get(token))!.identifier).toBe(ADMIN);
    await flows.destroy(token);
    await flows.update(token, { csrf: "x", target: { kind: "home" } });
    expect(await flows.get(token)).toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)("SMS sign-in store in Postgres", () => {
  const dbName = `identity_test_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let store: PgIdentityStore;
  let dbUrl: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    dbUrl = u.href;
    store = new PgIdentityStore(dbUrl);
    expect(await store.migrate()).toEqual([
      "001_sms_login.sql",
      "002_email_passkeys.sql",
      "003_passkey_id_check.sql",
      "004_google_access_requests.sql",
    ]);
    expect(await store.migrate()).toEqual([]);
  });

  afterAll(async () => {
    await store?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("bootstraps the first admin once, and only while no admin is connected", async () => {
    expect(
      await store.bootstrapAdmin([
        { method: "email", identifier: ADMIN },
        { method: "phone", identifier: "+32470000001" },
      ]),
    ).toBe("bootstrapped");
    expect(await store.bootstrapAdmin([{ method: "email", identifier: "x@example.test" }])).toBe("unchanged");
    const [c] = await store.connections();
    expect(c).toMatchObject({ label: ADMIN, status: "active", isAdmin: true, lastLoginAt: null });
  });

  it("a proved number gets one principal and nothing else", async () => {
    const id = await store.verifiedLogin("email", OTHER);
    expect(await store.verifiedLogin("email", OTHER)).toBe(id);
    expect(await store.principal(id)).toEqual({
      id,
      isAdmin: false,
      connection: "none",
      label: OTHER,
      methods: ["email"],
    });
    expect(await store.verifiedLogin("phone", PHONE)).not.toBe(id);
    const parallel = await Promise.all(Array.from({ length: 5 }, () => store.verifiedLogin("email", "p@example.test")));
    expect(new Set(parallel).size).toBe(1);
    expect(await store.principal("not-a-uuid")).toBeNull();
  });

  it("requests: one pending at a time, decided once; revoke and reconnect", async () => {
    const adminId = (await store.connections())[0]!.principalId;
    const id = await store.verifiedLogin("email", OTHER);
    expect(await store.requestConnection(id)).toBe("created");
    expect(await store.requestConnection(id)).toBe("already_pending");
    const [r] = await store.pendingRequests();
    expect(r).toMatchObject({ principalId: id, label: OTHER });
    expect(await store.decideRequest(r!.id, "approved", adminId)).toBe(id);
    expect(await store.decideRequest(r!.id, "rejected", adminId)).toBeNull();
    expect((await store.principal(id))!.connection).toBe("active");
    expect(await store.requestConnection(id)).toBe("already_connected");

    expect(await store.revoke(id, adminId)).toBe(true);
    expect(await store.revoke(id, adminId)).toBe(false);
    expect((await store.principal(id))!.connection).toBe("revoked");
    expect(await store.addConnection("email", OTHER, adminId)).toBe(id);
    expect((await store.principal(id))!.connection).toBe("active");

    const events = (await store.recentAudit(20)).map((a) => a.event);
    expect(events).toEqual(
      expect.arrayContaining(["request.approved", "connection.revoked", "connection.added", "connection.bootstrapped"]),
    );
  });

  it("Google: one principal per Google account; joins an address only when Google is its authority", async () => {
    const adminId = (await store.connections())[0]!.principalId;
    // Gmail: joins the principal that already holds the address, and keeps it as the label.
    const holder = await store.verifiedLogin("email", "g@gmail.com");
    expect(await store.verifiedGoogleLogin("111", "g@gmail.com", true)).toBe(holder);
    expect(await store.verifiedGoogleLogin("111", "g@gmail.com", true)).toBe(holder);
    expect((await store.principal(holder))!.methods).toEqual(["email", "google"]);
    // Not the authority: a principal of its own, labelled by the address, which proves nothing.
    const other = await store.verifiedGoogleLogin("222", OTHER, false);
    expect(other).not.toBe(await store.verifiedLogin("email", OTHER));
    expect(await store.principal(other)).toMatchObject({ label: OTHER, methods: ["google"], connection: "none" });
    // No address at all: no label, still a principal.
    const bare = await store.verifiedGoogleLogin("333", null, false);
    expect((await store.principal(bare))!.label).toBeNull();
    // A new Gmail address becomes a verified email identity of the new principal.
    const fresh = await store.verifiedGoogleLogin("444", "fresh@gmail.com", true);
    expect((await store.principal(fresh))!.methods).toEqual(["email", "google"]);
    const parallel = await Promise.all(Array.from({ length: 5 }, () => store.verifiedGoogleLogin("555", null, false)));
    expect(new Set(parallel).size).toBe(1);
    await expect(store.verifiedGoogleLogin("../bad", null, false)).rejects.toThrow();

    // Requests carry apps and a note; a connected person can ask for more apps.
    expect(await store.requestConnection(other, { apps: ["docs"], note: "hi" })).toBe("created");
    expect(await store.requestConnection(other, { apps: ["docs"], note: null })).toBe("already_pending");
    expect(await store.requestConnection(other, { apps: ["notes"], note: null })).toBe("updated");
    expect(await store.pendingRequest(other)).toMatchObject({ apps: ["docs", "notes"], note: "hi" });
    const [r] = (await store.pendingRequests()).filter((x) => x.principalId === other);
    expect(r).toMatchObject({ label: OTHER, methods: ["google"], connected: false, apps: ["docs", "notes"] });
    await store.decideRequest(r!.id, "approved", adminId);
    expect(await store.requestConnection(other)).toBe("already_connected");
    expect(await store.requestConnection(other, { apps: ["admin"], note: null })).toBe("created");
    expect((await store.pendingRequests()).find((x) => x.principalId === other)).toMatchObject({ connected: true });

    // Reconnect by principal, whatever the way they sign in.
    expect(await store.reconnect(other, adminId)).toBe(false);
    await store.revoke(other, adminId);
    expect(await store.reconnect(other, adminId)).toBe(true);
    expect((await store.principal(other))!.connection).toBe("active");
    expect((await store.connections()).find((c) => c.principalId === other)).toMatchObject({ label: OTHER });

    expect(await store.adminEmails()).toEqual([ADMIN]);
  });

  it("stores passkeys per principal: look up, count forward, remove", async () => {
    const id = await store.verifiedLogin("email", "keys@example.test");
    const credentialId = "A".repeat(43);
    await store.addPasskey(id, {
      credentialId,
      publicKey: { kty: "OKP", crv: "Ed25519", x: "B".repeat(43) },
      alg: -8,
      signCount: 0,
      transports: ["internal"],
      name: "Passkey 1",
    });
    expect(await store.passkey(credentialId)).toMatchObject({ principalId: id, alg: -8, signCount: 0 });
    await store.touchPasskey(credentialId, 7);
    expect((await store.passkey(credentialId))!.signCount).toBe(7);
    expect(await store.removePasskey(id, credentialId)).toBe(true);
    expect(await store.passkey(credentialId)).toBeNull();

    // 003: the credential id's shape is still enforced, up to the 1400 characters 002 meant.
    const key = { publicKey: { kty: "OKP", crv: "Ed25519", x: "B".repeat(43) }, alg: -8, signCount: 0, transports: [] };
    await store.addPasskey(id, { ...key, credentialId: "C".repeat(1400), name: "Long" });
    for (const bad of ["A".repeat(15), "A".repeat(1401), `${"A".repeat(20)}+/`])
      await expect(store.addPasskey(id, { ...key, credentialId: bad, name: "Bad" }), bad.slice(-3)).rejects.toThrow(
        /passkeys_credential_id_check/,
      );
  });

  it("keeps the audit trail append-only and numbers in E.164", async () => {
    await store.audit({ event: "otp.sent", method: "sms", subjectHandle: "h", detail: { n: 1 } });
    const raw = new pg.Pool({ connectionString: dbUrl, max: 1 });
    raw.on("error", () => undefined); // the final DROP DATABASE … WITH (FORCE) may catch it closing
    try {
      await expect(raw.query("UPDATE audit_log SET event = 'x'")).rejects.toThrow(/append-only/);
      await expect(raw.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
      await expect(
        raw.query(
          "INSERT INTO identities (method, identifier, principal_id) SELECT 'phone', '0470', id FROM principals LIMIT 1",
        ),
      ).rejects.toThrow(/identities_phone_e164/);
    } finally {
      await raw.end();
    }
  });
});

describe.skipIf(!REDIS_URL)("OIDC sign-in with the SMS method (Redis, in-memory store)", () => {
  const SECRET = randomBytes(32).toString("base64url");
  const CLIENT_ID = "demo";
  let redis: Redis;
  let op: Server;
  let rp: Server;
  let issuer: string;
  let rpBase: string;
  const store = new MemoryStore();
  const mailer = new CapturingMailer();

  class Jar {
    private readonly cookies = new Map<string, string>();
    take(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair!.indexOf("=");
        const name = pair!.slice(0, i);
        const value = pair!.slice(i + 1);
        if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    header() {
      return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
  }

  beforeAll(async () => {
    redis = new Redis(redisDb14(REDIS_URL!));
    await redis.flushdb();
    await store.bootstrapAdmin([{ method: "email", identifier: ADMIN }]);

    rp = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("rp");
    });
    await new Promise<void>((r) => rp.listen(0, r));
    rpBase = `http://localhost:${(rp.address() as AddressInfo).port}`;

    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const signing = { ...(await exportJWK(privateKey)), kid: "k1", alg: "ES256", use: "sig" };
    op = createServer();
    await new Promise<void>((r) => op.listen(0, r));
    issuer = `http://localhost:${(op.address() as AddressInfo).port}`;

    const log = createLogger((l) => process.env.IDENTITY_TEST_LOG && console.log(l));
    const signIn = createSignIn({
      issuer,
      homeUrl: `${rpBase}/`,
      otpSecret: "o".repeat(40),
      email: { mailer, dailyLimit: 100 },
      ephemeral: new RedisEphemeral(redis),
      store,
      challenges: new RedisOtpChallenges(redis),
      limits: new RedisRateLimiter(redis),
      sessions: new RedisAuthSessions(redis),
      flows: new RedisLoginFlows(redis),
      endProviderSessions: (id) => endSessionsOfAccount(redis, id),
      log,
    });
    const provider = createProvider({
      issuer,
      jwks: { keys: [signing] },
      cookieKeys: [randomBytes(32).toString("hex")],
      clients: loadClients(
        {
          clients: [
            {
              client_id: CLIENT_ID,
              primary_domain: "demo.example",
              redirect_uris: [`${rpBase}/cb`],
              client_secret_env: "DEMO_SECRET",
            },
          ],
        },
        { DEMO_SECRET: SECRET },
        { allowLocalhost: true },
      ),
      loginMethod: "local",
      signIn,
      trustProxy: false,
      adapter: redisAdapterFactory(redis),
      accounts: new PrincipalAccounts(store),
      readiness: async () => ({ redis: true, database: true }),
      log,
    });
    op.on("request", provider.callback());
  });

  afterAll(async () => {
    op?.close();
    rp?.close();
    await redis?.flushdb();
    await redis?.quit();
  });

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  async function get(url: string, jar: Jar) {
    const res = await fetch(new URL(url, issuer), { redirect: "manual", headers: { cookie: jar.header() } });
    jar.take(res);
    return res;
  }

  async function post(path: string, jar: Jar, form: Record<string, string>) {
    const res = await fetch(new URL(path, issuer), {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    jar.take(res);
    return res;
  }

  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const refreshOf = (html: string) => /content="0;url=([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");

  function authUrl(challenge: string, extra: Record<string, string> = {}) {
    const u = new URL(`${issuer}/auth`);
    for (const [k, v] of Object.entries({
      client_id: CLIENT_ID,
      redirect_uri: `${rpBase}/cb`,
      response_type: "code",
      scope: "openid roles",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...extra,
    }))
      u.searchParams.set(k, v);
    return u.href;
  }

  /** From /auth to the SMS sign-in, through the code, to wherever the browser ends up. */
  async function signInAs(email: string, jar: Jar, extra: Record<string, string> = {}) {
    const { verifier, challenge } = pkce();
    let res = await get(authUrl(challenge, extra), jar);
    const interaction = res.headers.get("location")!;
    res = await get(interaction, jar);
    expect(res.status).toBe(302);
    const login = res.headers.get("location")!;
    expect(login).toMatch(/^\/login\?uid=/);
    await redis.del(...(await redis.keys(`${KEY_PREFIX}sms-cd:*`)), "none"); // no resend cooldown between tests
    res = await get(login, jar);
    const csrf = csrfOf(await res.text());
    res = await post("/login/start", jar, { csrf, via: "email", identifier: email });
    expect(res.status).toBe(303);
    res = await post("/login/verify", jar, { csrf, code: mailer.lastCode(email) });
    if (res.status !== 200) return { res, verifier };
    let location = refreshOf(await res.text())!;
    expect(location).toBe(new URL(interaction, issuer).pathname);
    for (let i = 0; i < 6 && !location.startsWith(`${rpBase}/cb`); i++) {
      res = await get(location, jar);
      location = new URL(res.headers.get("location")!, issuer).href;
    }
    return { res, verifier, callback: new URL(location) };
  }

  async function token(body: Record<string, string>) {
    const res = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("a connected number: SMS code → tokens for its principal; the next app sign-in needs no code", async () => {
    const jar = new Jar();
    const { callback, verifier } = await signInAs(ADMIN, jar);
    const code = callback!.searchParams.get("code")!;
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${rpBase}/cb`,
      code_verifier: verifier,
    });
    expect(t.status).toBe(200);
    const me = (await (
      await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${t.json.access_token}` } })
    ).json()) as { sub: string; roles: string[] };
    expect(await store.principal(me.sub)).toMatchObject({ label: ADMIN, connection: "active" });
    expect(me.roles).toEqual(["identity.admin"]);

    // Single sign-on: a second authorization in the same browser goes straight to the callback.
    const sent = mailer.sent.length;
    const { challenge } = pkce();
    let res = await get(authUrl(challenge), jar);
    let location = new URL(res.headers.get("location")!, issuer).href;
    for (let i = 0; i < 6 && !location.startsWith(`${rpBase}/cb`); i++) {
      res = await get(location, jar);
      location = new URL(res.headers.get("location")!, issuer).href;
    }
    expect(new URL(location).searchParams.get("code")).toBeTruthy();
    expect(mailer.sent.length).toBe(sent);
  });

  it("an unconnected number proves itself but gets no code for the app", async () => {
    const jar = new Jar();
    const { res } = await signInAs(OTHER, jar);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    const page = await (await get("/login", jar)).text();
    expect(page).toContain("Ask for access");
  });

  it("revoking ends the provider session and refresh tokens stop working", async () => {
    const adminId = (await store.connections()).find((c) => c.label === ADMIN)!.principalId;
    const userId = await store.addConnection("email", "five@example.test", adminId);
    const jar = new Jar();
    const { callback, verifier } = await signInAs("five@example.test", jar, {
      scope: "openid offline_access",
      prompt: "consent",
    });
    const t = await token({
      grant_type: "authorization_code",
      code: callback!.searchParams.get("code")!,
      redirect_uri: `${rpBase}/cb`,
      code_verifier: verifier,
    });
    expect(t.json.refresh_token).toBeTruthy();

    await store.revoke(userId, adminId);
    expect(await endSessionsOfAccount(redis, userId)).toBe(1);

    expect(
      (await token({ grant_type: "refresh_token", refresh_token: t.json.refresh_token as string })).json.error,
    ).toBe("invalid_grant");
    const ui = await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${t.json.access_token}` } });
    expect(ui.status).toBe(401);
    // The browser's next sign-in starts from the SMS step again.
    const { challenge } = pkce();
    const res = await get(authUrl(challenge), jar);
    const next = await get(res.headers.get("location")!, jar);
    expect(next.headers.get("location")).toMatch(/^\/login\?uid=/);
  });
});
