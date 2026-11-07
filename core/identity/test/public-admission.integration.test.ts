/**
 * Public admission (#341), against the real thing: Postgres (PgIdentityStore + PrincipalAccounts), Redis, and
 * the real oidc-provider with the real sign-in routes. Only the mail transport and Google's token exchange are
 * stand-ins. Nothing here is proven against MemoryStore.
 *
 * Skipped without IDENTITY_TEST_REDIS_URL and IDENTITY_TEST_DATABASE_URL; in CI a skip is a failure.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Redis } from "ioredis";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisAuthSessions, RedisEphemeral, RedisLoginFlows } from "../src/auth-session.ts";
import { loadClients } from "../src/clients.ts";
import { createLogger } from "../src/log.ts";
import { RedisOtpChallenges, RedisRateLimiter } from "../src/otp.ts";
import { createProvider, endBrowserSession } from "../src/provider.ts";
import { KEY_PREFIX, endSessionsOfAccount, redisAdapterFactory } from "../src/redis-adapter.ts";
import { createSignIn } from "../src/sign-in.ts";
import { PgIdentityStore, PrincipalAccounts } from "../src/store.ts";
import { CapturingMailer, FakeGoogle, pid } from "./fakes.ts";

const REDIS_URL = process.env.IDENTITY_TEST_REDIS_URL;
const DATABASE_URL = process.env.IDENTITY_TEST_DATABASE_URL;
if (process.env.CI && (!REDIS_URL || !DATABASE_URL)) {
  throw new Error("IDENTITY_TEST_REDIS_URL and IDENTITY_TEST_DATABASE_URL must be set in CI");
}

/** Logical Redis DB 13: the other integration files use 12, 14 and 15. */
function redisDb13(url: string) {
  const u = new URL(url);
  u.pathname = "/13";
  return u.href;
}

const ADMIN = "admin@example.test";
const NEWBIE = "newbie@example.test";
const SECRET = randomBytes(32).toString("base64url");
const PUB = "pubapp";
const RES = "resapp";

describe.skipIf(!REDIS_URL || !DATABASE_URL)("public admission, real provider + Postgres + Redis", () => {
  const dbName = `identity_pub_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let redis: Redis;
  let store: PgIdentityStore;
  let op: Server;
  let rp: Server;
  let issuer: string;
  let rpBase: string;
  let adminId: string;
  let jwks: ReturnType<typeof createLocalJWKSet>;
  const mailer = new CapturingMailer();
  const google = new FakeGoogle();

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
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    store = new PgIdentityStore(u.href);
    await store.migrate();
    db = new pg.Pool({ connectionString: u.href, max: 2 });
    redis = new Redis(redisDb13(REDIS_URL!));
    await redis.flushdb();
    await store.bootstrapAdmin([{ method: "email", identifier: ADMIN }]);
    adminId = (await store.connections()).find((c) => c.label === ADMIN)!.principalId;

    rp = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("rp");
    });
    await new Promise<void>((r) => rp.listen(0, r));
    rpBase = `http://localhost:${(rp.address() as AddressInfo).port}`;

    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const signing = { ...(await exportJWK(privateKey)), kid: "k1", alg: "ES256", use: "sig" };
    jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" }] });
    op = createServer();
    await new Promise<void>((r) => op.listen(0, r));
    issuer = `http://localhost:${(op.address() as AddressInfo).port}`;

    const file = {
      clients: [
        {
          client_id: PUB,
          name: "Public app",
          primary_domain: "pub.example",
          redirect_uris: [`${rpBase}/cb`],
          client_secret_env: "PUB_SECRET",
          admission: "public" as const,
        },
        {
          client_id: RES,
          name: "Restricted app",
          primary_domain: "res.example",
          redirect_uris: [`${rpBase}/cb`],
          client_secret_env: "RES_SECRET",
        },
      ],
    };
    const { admissionPolicies, appLinks } = await import("../src/clients.ts");
    const policies = admissionPolicies(file);
    const log = createLogger((l) => process.env.IDENTITY_TEST_LOG && console.log(l));
    const late: { provider?: ReturnType<typeof createProvider> } = {};
    const signIn = createSignIn({
      issuer,
      homeUrl: `${rpBase}/`,
      apps: appLinks(file),
      admission: policies,
      otpSecret: "o".repeat(40),
      email: { mailer, dailyLimit: 1000 },
      google,
      ephemeral: new RedisEphemeral(redis),
      store,
      challenges: new RedisOtpChallenges(redis),
      limits: new RedisRateLimiter(redis),
      sessions: new RedisAuthSessions(redis),
      flows: new RedisLoginFlows(redis),
      endProviderSessions: (id) => endSessionsOfAccount(redis, id),
      endBrowserProviderSession: async (ctx) => {
        if (late.provider) await endBrowserSession(late.provider, ctx);
      },
      log,
    });
    const provider = createProvider({
      issuer,
      jwks: { keys: [signing] },
      cookieKeys: [randomBytes(32).toString("hex")],
      clients: loadClients(file, { PUB_SECRET: SECRET, RES_SECRET: SECRET }, { allowLocalhost: true }),
      admission: policies,
      loginMethod: "local",
      signIn,
      trustProxy: false,
      adapter: redisAdapterFactory(redis),
      accounts: new PrincipalAccounts(store),
      readiness: async () => ({ redis: true, database: true }),
      log,
    });
    late.provider = provider;
    op.on("request", provider.callback());
  });

  afterAll(async () => {
    op?.close();
    rp?.close();
    await redis?.flushdb();
    await redis?.quit();
    await store?.close();
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  // ---- helpers ------------------------------------------------------------------------------------

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  async function get(url: string, jar: Jar, headers: Record<string, string> = {}) {
    const res = await fetch(new URL(url, issuer), {
      redirect: "manual",
      headers: { cookie: jar.header(), ...headers },
    });
    jar.take(res);
    return res;
  }

  async function post(url: string, jar: Jar, form: Record<string, string>) {
    const res = await fetch(new URL(url, issuer), {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    jar.take(res);
    return res;
  }

  /** No resend cooldown and a fresh budget between steps: every request here comes from one address. */
  const resetLimits = async () =>
    redis.del(...(await redis.keys(`${KEY_PREFIX}sms-cd:*`)), ...(await redis.keys(`${KEY_PREFIX}sms-rl:*`)), "none");

  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const refreshOf = (html: string) => /content="0;url=([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");

  function authUrl(client: string, challenge: string, extra: Record<string, string> = {}) {
    const u = new URL(`${issuer}/auth`);
    for (const [k, v] of Object.entries({
      client_id: client,
      redirect_uri: `${rpBase}/cb`,
      response_type: "code",
      scope: "openid email roles offline_access",
      prompt: "consent",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...extra,
    }))
      u.searchParams.set(k, v);
    return u.href;
  }

  /** Follow redirects until the callback, a login page, or a page that is not a redirect. */
  async function follow(res: Response, jar: Jar) {
    for (let i = 0; i < 10; i++) {
      const loc = res.headers.get("location");
      if (!loc || res.status < 300 || res.status > 399) return { res };
      const next = new URL(loc, issuer);
      if (next.href.startsWith(`${rpBase}/cb`)) return { res, callback: next };
      if (next.pathname === "/login" && next.searchParams.has("uid"))
        return { res, loginUrl: next.pathname + next.search };
      res = await get(next.href, jar);
    }
    throw new Error("too many redirects");
  }

  async function authorize(client: string, jar: Jar, extra: Record<string, string> = {}, query = "") {
    const { verifier, challenge } = pkce();
    const first = await get(authUrl(client, challenge, extra) + query, jar);
    return { verifier, ...(await follow(first, jar)) };
  }

  /** The email-code step on a login page; returns where the browser ends up (the callback, or the access page). */
  async function codeSignIn(loginUrl: string, email: string, jar: Jar) {
    await resetLimits();
    let res = await get(loginUrl, jar);
    const csrf = csrfOf(await res.text());
    res = await post("/login/start", jar, { csrf, via: "email", identifier: email });
    expect(res.status).toBe(303);
    const code = mailer.lastCode(email);
    res = await post("/login/verify", jar, { csrf, code });
    return { res, code, csrf };
  }

  /** From /auth through the code to the end. `callback` is set when the app got its code. */
  async function signInAt(client: string, email: string, jar: Jar, extra: Record<string, string> = {}) {
    const a = await authorize(client, jar, extra);
    if (a.callback) return { ...a, callback: a.callback };
    expect(a.loginUrl, "expected the login page").toBeTruthy();
    const { res } = await codeSignIn(a.loginUrl!, email, jar);
    if (res.status === 200) {
      let location = refreshOf(await res.text())!;
      for (let i = 0; i < 8 && !location.startsWith(`${rpBase}/cb`); i++) {
        const step = await get(location, jar);
        location = new URL(step.headers.get("location") ?? "/", issuer).href;
      }
      return { verifier: a.verifier, res, callback: new URL(location) as URL | undefined };
    }
    return { verifier: a.verifier, res, callback: undefined as URL | undefined };
  }

  async function token(client: string, body: Record<string, string>) {
    const res = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${client}:${SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const exchange = (client: string, callback: URL, verifier: string) =>
    token(client, {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: `${rpBase}/cb`,
      code_verifier: verifier,
    });

  const refresh = (client: string, refreshToken: string) =>
    token(client, { grant_type: "refresh_token", refresh_token: refreshToken });

  const userinfo = (accessToken: string) =>
    fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${accessToken}` } });

  const count = async (table: string, where = "true") =>
    Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);
  const admissionsOf = async (principalId: string) =>
    (
      await db.query("SELECT client_id FROM client_admissions WHERE principal_id = $1 ORDER BY 1", [principalId])
    ).rows.map((r) => r.client_id as string);
  const principalOf = async (email: string) =>
    (await db.query("SELECT principal_id FROM identities WHERE method = 'email' AND identifier = $1", [email])).rows[0]
      ?.principal_id as string | undefined;

  // ---- the observable result ----------------------------------------------------------------------

  it("a fresh person signs up at a public app with no admin: valid ID token, refresh, userinfo, no role", async () => {
    const pendingBefore = await count("connection_requests", "status = 'pending'");
    const connectionsBefore = await count("connections");
    const jar = new Jar();
    const { callback, verifier } = await signInAt(PUB, NEWBIE, jar);
    expect(callback, "the public app got its code").toBeDefined();

    const t = await exchange(PUB, callback!, verifier);
    expect(t.status).toBe(200);
    const { payload } = await jwtVerify(t.json.id_token as string, jwks, { issuer, audience: PUB });
    const sub = await principalOf(NEWBIE);
    expect(payload.sub).toBe(sub);
    expect(payload.email).toBe(NEWBIE);
    expect(payload.email_verified).toBe(true);
    expect(payload.roles).toEqual([]); // signup never grants a role

    // Exactly one admission for this app, and no global connection and no pending request.
    expect(await admissionsOf(sub!)).toEqual([PUB]);
    expect(await count("connections")).toBe(connectionsBefore);
    expect(await count("connections", `principal_id = '${sub}'`)).toBe(0);
    expect(await count("connection_requests", "status = 'pending'")).toBe(pendingBefore);
    expect(await count("audit_log", `event = 'connection.admitted' AND principal_id = '${sub}'`)).toBe(1);

    // Userinfo works, and the refresh token works and rotates.
    const me = await userinfo(t.json.access_token as string);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ sub, email: NEWBIE, email_verified: true });
    const r1 = await refresh(PUB, t.json.refresh_token as string);
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.json.refresh_token);
    // The rotated-away token is dead (reuse fails).
    expect((await refresh(PUB, t.json.refresh_token as string)).status).toBe(400);
  });

  it("the same person at a restricted app still sees the request-access page and gets no code", async () => {
    const sub = (await principalOf(NEWBIE))!;
    const pendingBefore = await count("connection_requests", "status = 'pending'");
    const jar = new Jar();
    // A cold sign-in at the restricted app.
    const cold = await signInAt(RES, NEWBIE, jar);
    expect(cold.callback).toBeUndefined();
    expect(cold.res.status).toBe(303);
    expect(cold.res.headers.get("location")).toBe("/login");
    expect(await (await get("/login", jar)).text()).toContain("Ask for access");
    // Signed in to the public app first, then the restricted app: same answer, from the existing session.
    const jar2 = new Jar();
    expect((await signInAt(PUB, NEWBIE, jar2)).callback).toBeDefined();
    const again = await authorize(RES, jar2);
    expect(again.callback).toBeUndefined();
    expect(await admissionsOf(sub)).toEqual([PUB]);
    expect(await count("connection_requests", "status = 'pending'")).toBe(pendingBefore);
  });

  it("an existing session at the public app needs no code the second time (SSO), still without any role", async () => {
    const jar = new Jar();
    const first = await signInAt(PUB, NEWBIE, jar);
    expect(first.callback).toBeDefined();
    const second = await authorize(PUB, jar);
    expect(second.callback).toBeDefined();
  });

  // ---- suspension wins ----------------------------------------------------------------------------

  async function gatesAfterSuspension(client: string, email: string, suspend: (sub: string) => Promise<void>) {
    const jar = new Jar();
    const { callback, verifier } = await signInAt(client, email, jar);
    const t = await exchange(client, callback!, verifier);
    expect(t.status).toBe(200);
    // A second code, issued before the suspension and exchanged after it.
    const pending = await authorize(client, jar);
    expect(pending.callback, "SSO issues a code").toBeDefined();
    const sub = (await principalOf(email))!;

    await suspend(sub);

    // Token: the pre-issued code is refused.
    expect((await exchange(client, pending.callback!, pending.verifier)).status).toBe(400);
    // Refresh: refused.
    expect((await refresh(client, t.json.refresh_token as string)).status).toBe(400);
    // Userinfo with a token issued before: refused.
    expect((await userinfo(t.json.access_token as string)).status).toBe(401);
    // A new authorization from the same browser (the provider session is still there): no code.
    const again = await authorize(client, jar);
    expect(again.callback).toBeUndefined();
    // A cold sign-in with a fresh code: no code either, and signing in again creates nothing.
    const cold = await signInAt(client, email, new Jar());
    expect(cold.callback).toBeUndefined();
    expect(cold.res.headers.get("location")).toBe("/login");
    return sub;
  }

  it("suspended public-only person: denied at login, code, token, refresh and userinfo; signup can't reactivate", async () => {
    const email = "suspend-pub@example.test";
    const sub = await gatesAfterSuspension(PUB, email, async (s) => {
      expect(await store.revoke(s, adminId)).toBe(true);
    });
    // Still exactly the one admission, still suspended, no second connection row, one admitted audit row.
    expect(await admissionsOf(sub)).toEqual([PUB]);
    expect((await store.principal(sub))!.connection).toBe("revoked");
    expect(await count("connections", `principal_id = '${sub}' AND source = 'suspension'`)).toBe(1);
    expect(await count("audit_log", `event = 'connection.admitted' AND principal_id = '${sub}'`)).toBe(1);

    // The admin can find them (a person with no connection row), and lifting the suspension restores
    // the admission and NOTHING more: they are not global.
    const row = (await store.connections()).find((c) => c.principalId === sub)!;
    expect(row).toMatchObject({ status: "revoked", global: false, clients: [PUB] });
    expect(await store.reconnect(sub, adminId)).toBe(true);
    const after = await store.principal(sub);
    expect(after).toMatchObject({ connection: "none", admittedClients: [PUB] });
    const jar = new Jar();
    expect((await signInAt(PUB, email, jar)).callback).toBeDefined();
    expect((await signInAt(RES, email, new Jar())).callback).toBeUndefined();
  });

  it("suspended person with a global connection: denied at every gate, at a public and a restricted app", async () => {
    const email = "suspend-global@example.test";
    const sub = await store.addConnection("email", email, adminId);
    await store.admitPublic(sub, PUB); // "global" outcome: no row is needed
    expect(await admissionsOf(sub)).toEqual([]);
    for (const client of [PUB, RES]) {
      const conn = await db.query("SELECT status FROM connections WHERE principal_id = $1", [sub]);
      if (conn.rows[0].status === "revoked") await store.reconnect(sub, adminId);
      await gatesAfterSuspension(client, email, async (s) => {
        expect(await store.revoke(s, adminId)).toBe(true);
      });
    }
  });

  it("a person who is both admitted and later suspended stays suspended after a Google link", async () => {
    const email = "linked-susp@gmail.com";
    const sub = await pid(store.verifiedLogin("email", email));
    await store.admitPublic(sub, PUB);
    await store.revoke(sub, adminId);
    const linked = await store.verifiedGoogleLogin("900000000000000000001", email, true);
    expect(linked).toMatchObject({ kind: "ok", principalId: sub, linked: true, created: false });
    expect((await store.principal(sub))!.connection).toBe("revoked");
    expect(await store.admitPublic(sub, "otherapp")).toBe("suspended");
    expect(await admissionsOf(sub)).toEqual([PUB]);
  });

  // ---- race and replay ----------------------------------------------------------------------------

  it("two parallel first sign-ins make one principal, one identity, one admission, one audit row", async () => {
    const email = "race@example.test";
    const results = await Promise.all([store.verifiedLogin("email", email), store.verifiedLogin("email", email)]);
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    const ids = new Set(results.map((r) => (r.kind === "ok" ? r.principalId : "")));
    expect(ids.size).toBe(1);
    const sub = [...ids][0]!;
    expect(results.filter((r) => r.kind === "ok" && r.created)).toHaveLength(1);
    expect(await count("identities", `method = 'email' AND identifier = '${email}'`)).toBe(1);
    expect(await count("principals", `id = '${sub}'`)).toBe(1);

    const admits = await Promise.all(Array.from({ length: 6 }, () => store.admitPublic(sub, PUB)));
    expect(admits.filter((o) => o === "admitted")).toHaveLength(1);
    expect(admits.filter((o) => o === "already")).toHaveLength(5);
    expect(await admissionsOf(sub)).toEqual([PUB]);
    expect(await count("audit_log", `event = 'connection.admitted' AND principal_id = '${sub}'`)).toBe(1);
  });

  it("an admission racing a suspension never leaves an admitted-and-active person after the suspension", async () => {
    const sub = await pid(store.verifiedLogin("email", "race-susp@example.test"));
    await store.admitPublic(sub, PUB); // so there is something to suspend
    await Promise.all([store.admitPublic(sub, "app-two"), store.revoke(sub, adminId)]);
    expect((await store.principal(sub))!.connection).toBe("revoked");
  });

  it("two browsers finishing a Google sign-up at once end with one principal and one admission", async () => {
    google.next = { subject: "940000000000000000001", email: "twin@gmail.com", authoritative: true };
    const jars = [new Jar(), new Jar()];
    const starts = await Promise.all(jars.map((j) => googleStart(j)));
    const done = await Promise.all(
      starts.map((st, i) =>
        get(`/login/google/callback?${new URLSearchParams({ code: "abc", state: st.state })}`, jars[i]!),
      ),
    );
    expect(done.map((r) => r.status)).toEqual([303, 303]);
    const codes = await Promise.all(done.map((r, i) => follow(r, jars[i]!)));
    expect(codes.every((c) => c.callback)).toBe(true);
    expect(await count("identities", "method = 'google' AND identifier = '940000000000000000001'")).toBe(1);
    const sub = (await db.query("SELECT principal_id FROM identities WHERE identifier = '940000000000000000001'"))
      .rows[0].principal_id as string;
    expect(await count("identities", `principal_id = '${sub}'`)).toBeLessThanOrEqual(2);
    expect(await admissionsOf(sub)).toEqual([PUB]);
    expect(await count("audit_log", `event = 'connection.admitted' AND principal_id = '${sub}'`)).toBe(1);
  });

  it("a replayed authorization code is refused and adds nothing", async () => {
    const email = "replay@example.test";
    const { callback, verifier } = await signInAt(PUB, email, new Jar());
    const principals = await count("principals");
    const first = await exchange(PUB, callback!, verifier);
    expect(first.status).toBe(200);
    const second = await exchange(PUB, callback!, verifier);
    expect(second.status).toBe(400);
    expect(second.json.error).toBe("invalid_grant");
    // oidc-provider revokes what the code produced when it is replayed.
    expect((await userinfo(first.json.access_token as string)).status).toBe(401);
    expect(await count("principals")).toBe(principals);
    expect(await admissionsOf((await principalOf(email))!)).toEqual([PUB]);
  });

  it("a replayed email code is refused", async () => {
    const jar = new Jar();
    const a = await authorize(PUB, jar);
    const { res, code, csrf } = await codeSignIn(a.loginUrl!, "otp-replay@example.test", jar);
    expect(res.status).toBe(200);
    const again = await post("/login/verify", jar, { csrf, code });
    expect(again.status).not.toBe(200);
    expect(await count("identities", "identifier = 'otp-replay@example.test'")).toBe(1);
  });

  /** From /auth to Google's start: the state Identity sent Google, with the browser's live flow. */
  async function googleStart(jar: Jar) {
    const a = await authorize(PUB, jar);
    await get(a.loginUrl!, jar);
    const start = await get("/login/google", jar);
    return { a, state: new URL(start.headers.get("location")!).searchParams.get("state")! };
  }

  it("a replayed or wrong Google state is refused and creates nothing", async () => {
    google.next = { subject: "910000000000000000001", email: "g-replay@gmail.com", authoritative: true };
    // Wrong state on a live flow: refused and audited, nothing created.
    const jar = new Jar();
    const { state } = await googleStart(jar);
    const principals = await count("principals");
    const wrong = await get(`/login/google/callback?${new URLSearchParams({ code: "abc", state: "not-it" })}`, jar);
    expect(wrong.status).toBe(400);
    expect(
      await count("audit_log", "event = 'google.failed' AND detail->>'reason' = 'state_mismatch'"),
    ).toBeGreaterThan(0);
    expect(await count("principals")).toBe(principals);
    // The real state works once; replaying it afterwards is refused and adds nothing.
    const back = `/login/google/callback?${new URLSearchParams({ code: "abc", state })}`;
    // (the wrong attempt used up the stored state: single use, so the person must start again)
    expect((await get(back, jar)).status).toBe(400);
    const j2 = new Jar();
    const fresh = await googleStart(j2);
    const ok = await get(`/login/google/callback?${new URLSearchParams({ code: "abc", state: fresh.state })}`, j2);
    expect(ok.status).toBe(303);
    const after = await count("principals");
    expect(after).toBe(principals + 1);
    const replay = await get(`/login/google/callback?${new URLSearchParams({ code: "abc", state: fresh.state })}`, j2);
    expect(replay.status).not.toBe(303);
    expect(await count("principals")).toBe(after);
    expect(await count("identities", "method = 'google' AND identifier = '910000000000000000001'")).toBe(1);
  });

  // ---- policy cannot be chosen by the browser -----------------------------------------------------

  it("no query, form field or header from a browser can make a restricted app public", async () => {
    const email = "sneaky@example.test";
    const jar = new Jar();
    const a = await authorize(RES, jar, { admission: "public" }, "&admission=public&policy=public");
    expect(a.callback).toBeUndefined();
    const extraHeaders = { "x-admission": "public", "x-forwarded-admission": "public" };
    await get(a.loginUrl!, jar, extraHeaders);
    await resetLimits();
    const page = await get(a.loginUrl!, jar);
    const csrf = csrfOf(await page.text());
    await post("/login/start", jar, { csrf, via: "email", identifier: email, admission: "public", client_id: PUB });
    const res = await post("/login/verify", jar, {
      csrf,
      code: mailer.lastCode(email),
      admission: "public",
      client_id: PUB,
    });
    expect(res.status).toBe(303); // not authorized: sent to the access page
    expect(await admissionsOf((await principalOf(email))!)).toEqual([]);
  });

  it("a person who is not admitted gets nothing from /admin", async () => {
    const jar = new Jar();
    expect((await signInAt(PUB, "noadmin@example.test", jar)).callback).toBeDefined();
    const res = await get("/admin", jar);
    expect(res.status).not.toBe(200);
  });

  // ---- email_verified ----------------------------------------------------------------------------

  it("email_verified is true only with stored evidence", async () => {
    // An address an admin typed in has none.
    const typed = await store.addConnection("email", "typed@example.test", adminId);
    expect((await store.principal(typed))!).toMatchObject({ label: "typed@example.test", emailVerified: false });
    // Proving it with a code stores it.
    await store.verifiedLogin("email", "typed@example.test");
    expect((await store.principal(typed))!.emailVerified).toBe(true);
    // A phone-only person has no email to verify.
    const phone = await pid(store.verifiedLogin("phone", "+32470000009"));
    expect((await store.principal(phone))!).toMatchObject({ emailVerified: false });
    const account = await new PrincipalAccounts(store).find(phone);
    expect(account!.email).toBeNull();
    expect(account!.emailVerified).toBeUndefined();
    // A Google account Google verified the address for.
    const g = await pid(store.verifiedGoogleLogin("920000000000000000001", "who@gmail.com", true));
    expect((await store.principal(g))!).toMatchObject({ label: "who@gmail.com", emailVerified: true });
  });

  // ---- linking ------------------------------------------------------------------------------------

  it("Google linking: an authoritative address joins the email principal; any other gets its own", async () => {
    const holder = await pid(store.verifiedLogin("email", "holder@gmail.com"));
    const joined = await store.verifiedGoogleLogin("930000000000000000001", "holder@gmail.com", true);
    expect(joined).toEqual({ kind: "ok", principalId: holder, created: false, linked: true });
    const other = await pid(store.verifiedLogin("email", "holder@corp.test"));
    const separate = await store.verifiedGoogleLogin("930000000000000000002", "holder@corp.test", false);
    expect(separate).toMatchObject({ kind: "ok", created: true });
    expect(separate.kind === "ok" && separate.principalId).not.toBe(other);
    // The same identifier twice never makes a second principal.
    expect(await store.verifiedGoogleLogin("930000000000000000002", "holder@corp.test", false)).toMatchObject({
      kind: "ok",
      principalId: separate.kind === "ok" ? separate.principalId : "",
      created: false,
    });
  });

  // ---- what the previous version would do ---------------------------------------------------------

  it("the previous version, reading only `connections`, finds a public-only person inactive (fails closed)", async () => {
    const sub = (await principalOf(NEWBIE))!;
    const old = await db.query("SELECT status FROM connections WHERE principal_id = $1", [sub]);
    // Old PrincipalAccounts.find: isActive = (connection.status === 'active'); no row means no access.
    expect(old.rows[0]?.status === "active").toBe(false);
    expect(await store.principal(sub)).toMatchObject({ connection: "none", admittedClients: [PUB] });
  });

  // ---- counts -------------------------------------------------------------------------------------

  it("the summary counts public admissions apart from admin connections", async () => {
    const counts = await store.auditCounts(new Date(0));
    const globalActive = await count("connections", "status = 'active'");
    expect(counts.activeConnections).toBe(globalActive);
    expect(counts.publicAdmissions).toBe(
      Number((await db.query("SELECT count(DISTINCT principal_id) n FROM client_admissions")).rows[0].n),
    );
    expect(counts.publicAdmissions).toBeGreaterThan(0);
  });
});

// ---- the migration, on data from before it ---------------------------------------------------------

describe.skipIf(!DATABASE_URL)("migration 006 on a database from before it", () => {
  const dbName = `identity_mig_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.href, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("leaves pending requests, connections and suspensions exactly as they were, and runs once", async () => {
    const dir = path.join(import.meta.dirname, "../migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.at(-1)).toBe("006_public_admission.sql");
    await pool.query(
      "CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const f of files.slice(0, -1)) {
      await pool.query(readFileSync(path.join(dir, f), "utf8"));
      await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", [f]);
    }
    // Data from before: pending, approved and rejected requests; an active, a revoked and a bootstrap connection.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await pool.query("INSERT INTO principals DEFAULT VALUES RETURNING id");
      ids.push(p.rows[0].id);
      await pool.query(
        "INSERT INTO identities (method, identifier, principal_id, verified_at) VALUES ('email', $1, $2, now())",
        [`old${i}@example.test`, ids[i]],
      );
    }
    await pool.query("INSERT INTO connections (principal_id, status) VALUES ($1, 'active')", [ids[0]]);
    await pool.query("INSERT INTO connections (principal_id, status, revoked_at) VALUES ($1, 'revoked', now())", [
      ids[1],
    ]);
    await pool.query("INSERT INTO connection_requests (principal_id) VALUES ($1), ($2), ($3)", [
      ids[2],
      ids[3],
      ids[4],
    ]);
    await pool.query(
      "INSERT INTO connection_requests (principal_id, status, decided_at) VALUES ($1, 'rejected', now())",
      [ids[5]],
    );
    const snap = async () => ({
      requests: (await pool.query("SELECT id, principal_id, status FROM connection_requests ORDER BY id")).rows,
      connections: (
        await pool.query(
          "SELECT principal_id, status, granted_by, revoked_at IS NOT NULL AS revoked FROM connections ORDER BY principal_id",
        )
      ).rows,
    });
    const before = await snap();
    expect(before.requests.filter((r) => r.status === "pending")).toHaveLength(3);

    const store = new PgIdentityStore(pool.options.connectionString!);
    try {
      expect(await store.migrate()).toEqual(["006_public_admission.sql"]);
      expect(await snap()).toEqual(before);
      expect(await store.migrate()).toEqual([]);
      // Legacy connections have no source (an admin's); nobody is admitted to anything.
      expect((await pool.query("SELECT count(*) n FROM connections WHERE source IS NOT NULL")).rows[0].n).toBe("0");
      expect((await pool.query("SELECT count(*) n FROM client_admissions")).rows[0].n).toBe("0");
      expect(await store.pendingRequests()).toHaveLength(3);
    } finally {
      await store.close();
    }
  });
});
