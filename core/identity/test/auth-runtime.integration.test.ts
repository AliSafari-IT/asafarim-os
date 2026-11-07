/**
 * @asafarim/auth-runtime against the REAL identity provider (S2, #344): `createProvider` (oidc-provider), the real
 * sign-in routes, Postgres (PgIdentityStore + PrincipalAccounts), Redis (provider adapter AND the runtime's Redis store)
 * and real HTTP listeners, one per "app" running the runtime's plain Node adapter. There are no provider mocks.
 *
 * What is NOT real, said plainly:
 *  - the mail transport (CapturingMailer: the e-mail code is read from the captured message, as the other identity
 *    integration tests do);
 *  - `testOnlyFetch`: oidc-provider refuses back-channel targets on loopback addresses, so the provider is given a PURE
 *    PASSTHROUGH fetch (it records the request and forwards it unchanged to the app's listener; it rewrites nothing and
 *    signs nothing). The logout tokens themselves are produced and signed by oidc-provider;
 *  - `delayedFetch` (runtime transport): forwards to the real provider, optionally after a delay, to hold a refresh open;
 *  - the injected clock: the runtime's `now` is real time plus an offset the test controls, to move past access-token
 *    and re-check windows without sleeping; the provider keeps real time;
 *  - negative logout tokens marked "crafted" are signed with the provider's own test signing key, because a real
 *    provider never emits an invalid one.
 *
 * Needs IDENTITY_TEST_REDIS_URL and IDENTITY_TEST_DATABASE_URL (CI sets both; under CI a missing one is a failure).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createNodeAuth, createSessionStateHandler, type NodeAuth } from "@asafarim/auth-runtime/node";
import { createRedisStore } from "@asafarim/auth-runtime/stores/redis";
import { asafarimAuthConfig } from "@asafarim/auth-runtime/authjs";
import { AuthRuntimeError, IdentityUnavailableError, StepUpRequiredError, StoreUnavailableError } from "@asafarim/auth-runtime";
import * as oidcClient from "openid-client";
import { Redis } from "ioredis";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisAuthSessions, RedisEphemeral, RedisLoginFlows } from "../src/auth-session.ts";
import { admissionPolicies, appLinks, loadClients } from "../src/clients.ts";
import { createLogger } from "../src/log.ts";
import { RedisOtpChallenges, RedisRateLimiter } from "../src/otp.ts";
import { createProvider, endBrowserSession } from "../src/provider.ts";
import { KEY_PREFIX, endSessionsOfAccount, redisAdapterFactory } from "../src/redis-adapter.ts";
import { notifySessionLogout } from "../src/logout.ts";
import { createSignIn } from "../src/sign-in.ts";
import { PgIdentityStore, PrincipalAccounts } from "../src/store.ts";
import { CapturingMailer, CapturingSender, FakeGoogle } from "./fakes.ts";

const REDIS_URL = process.env.IDENTITY_TEST_REDIS_URL;
const DATABASE_URL = process.env.IDENTITY_TEST_DATABASE_URL;
const CONFIGURED = Boolean(REDIS_URL && DATABASE_URL);
if (process.env.CI && !CONFIGURED) throw new Error("IDENTITY_TEST_REDIS_URL and IDENTITY_TEST_DATABASE_URL must be set in CI");

/** Logical Redis DB 11: the other integration files use 12 to 15 (public-admission uses 13). */
function redisDb11(url: string) {
  const u = new URL(url);
  u.pathname = "/11";
  return u.href;
}

const SECRET = randomBytes(32).toString("base64url");
const STORE_SECRET = randomBytes(32).toString("base64url");
const ADMIN = "rt-admin@example.test";
const A = "rtapp"; // public admission, back-channel logout, the main client
const B = "rtapp2"; // public admission: the second app (SSO, one account)
const R = "rtres"; // restricted (the default policy)

if (!CONFIGURED) {
  describe("auth-runtime against the real provider (needs IDENTITY_TEST_REDIS_URL and IDENTITY_TEST_DATABASE_URL)", () => {
    it("is not configured here: CI sets both and fails without them", () => {
      expect(process.env.CI).toBeUndefined();
    });
  });
} else {
  describe("auth-runtime against the real provider: createProvider + Postgres + Redis + HTTP", () => {
    // ---- the world -------------------------------------------------------------------------------------------------
    const dbName = `identity_rt_${randomBytes(4).toString("hex")}`;
    let admin: pg.Pool;
    let db: pg.Pool;
    let redis: Redis;
    let store: PgIdentityStore;
    let op: Server;
    let opPort = 0;
    let issuer = "";
    let provider: ReturnType<typeof createProvider>;
    let signingKey: KeyLike;
    let adminId = "";
    const mailer = new CapturingMailer();
    const sms = new CapturingSender();
    const google = new FakeGoogle();
    /** The runtime's clock: real time plus an offset the test moves. The provider always keeps real time. */
    const clock = { offset: 0, now: () => Date.now() + clock.offset };
    const providerEvents: { name: string; grantType?: string }[] = [];
    /** What oidc-provider sent to the apps' back-channel endpoints (recorded by the passthrough fetch). */
    const backchannelSent: { url: string; body: string; status?: number }[] = [];
    const auditLines: string[] = [];
    const logLines: string[] = [];
    let delayTokenMs = 0;
    const transport = { tokenRequests: 0, down: false };

    interface App {
      id: string;
      base: string;
      server: Server;
      auth: NodeAuth;
      redisPrefix: string;
    }
    const apps: Record<string, App> = {};
    /** Whether an app's "management" rule is on, by subject: the app-owned hook the runtime calls on every request. */
    const managementFor = new Set<string>();
    const noAccess = new Set<string>();

    class Jar {
      private readonly cookies = new Map<string, string>();
      take(res: Response) {
        for (const c of res.headers.getSetCookie()) {
          const [pair] = c.split(";");
          const i = pair!.indexOf("=");
          const name = pair!.slice(0, i);
          const value = pair!.slice(i + 1);
          if (!value || /expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0/i.test(c)) this.cookies.delete(name);
          else this.cookies.set(name, value);
        }
      }
      header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      }
      get(name: string) {
        return this.cookies.get(name);
      }
    }

    /** Everything a browser saw in one scenario: every URL, header and body, scanned later for tokens. */
    class Trail {
      readonly parts: string[] = [];
      note(res: Response, body?: string) {
        this.parts.push(res.url, ...[...res.headers].map(([k, v]) => `${k}: ${v}`), ...res.headers.getSetCookie(), body ?? "");
      }
      text() {
        return this.parts.join("\n");
      }
    }

    // ---- servers -----------------------------------------------------------------------------------------------------

    function appHandler(id: string) {
      return (req: IncomingMessage, res: ServerResponse) => {
        const app = apps[id];
        if (!app) {
          res.writeHead(503).end();
          return;
        }
        // The plain Node adapter first; everything else is "the app's own pages" (a page that proves a guard works).
        app.auth.handle(req, res).then(
          async (handled) => {
            if (handled) return;
            const url = new URL(req.url ?? "/", app.base);
            if (url.pathname === "/guarded") {
              try {
                const h = await app.auth.require(req, { policy: "management" });
                res.writeHead(200).end(`ok ${h.view.identityKey.sub}`);
              } catch (e) {
                res.writeHead(e instanceof AuthRuntimeError ? e.status : 500).end((e as AuthRuntimeError).code);
              }
              return;
            }
            res.writeHead(200, { "content-type": "text/plain" }).end("page");
          },
          () => res.writeHead(500).end(),
        );
      };
    }

    /** A runtime transport that forwards to the real provider; it can hold the token endpoint open. */
    const delayedFetch: typeof fetch = async (input, init) => {
      if (transport.down) throw new TypeError("fetch failed");
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/token")) {
        transport.tokenRequests++;
        if (delayTokenMs) await new Promise((r) => setTimeout(r, delayTokenMs));
      }
      return fetch(input, init);
    };

    const BOUNDS = {
      absoluteMs: 12 * 3600_000,
      idleMs: 30 * 60_000,
      freshMs: 5 * 60_000,
      revalidateMs: 60_000,
      refreshLeaseMs: 5000,
    };

    function makeAuth(id: string, base: string, over: { bounds?: typeof BOUNDS; redisClient?: Redis; prefix?: string } = {}): NodeAuth {
      const prefix = over.prefix ?? `rt-${id}`;
      const s = createRedisStore({ redis: over.redisClient ?? redis, secret: STORE_SECRET, prefix });
      return createNodeAuth({
        issuer,
        clientId: id,
        clientSecret: SECRET,
        origin: base,
        allowInsecureHttp: true,
        fetch: delayedFetch,
        postLogoutRedirectUri: `${base}/`,
        store: s,
        flows: s,
        bounds: over.bounds ?? BOUNDS,
        policies: ["management"],
        locales: ["en", "nl"],
        defaultLocale: "en",
        allowedReturnOrigins: [],
        intents: { signin: {}, register: { screen_hint: "register" } },
        hooks: {
          authorize: async (session, policy) => {
            if (noAccess.has(session.identityKey.sub)) return false;
            return policy === "access" || (policy === "management" && managementFor.has(session.identityKey.sub));
          },
        },
        deps: {
          now: clock.now,
          log: (l) => logLines.push(JSON.stringify(l)),
          audit: (e, d) => auditLines.push(JSON.stringify([e, d])),
        },
      });
    }

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      await admin.query(`CREATE DATABASE ${dbName}`);
      const u = new URL(DATABASE_URL!);
      u.pathname = `/${dbName}`;
      store = new PgIdentityStore(u.href);
      await store.migrate();
      db = new pg.Pool({ connectionString: u.href, max: 2 });
      db.on("error", () => undefined);
      redis = new Redis(redisDb11(REDIS_URL!));
      await redis.flushdb();
      await store.bootstrapAdmin([{ method: "email", identifier: ADMIN }]);
      adminId = (await store.connections()).find((c) => c.label === ADMIN)!.principalId;

      // Reserve the apps' ports first: the provider's client registrations name their URLs.
      for (const id of [A, B, R]) {
        const server = createServer(appHandler(id));
        await new Promise<void>((r) => server.listen(0, "localhost", r));
        apps[id] = { id, base: `http://localhost:${(server.address() as AddressInfo).port}`, server, auth: undefined as unknown as NodeAuth, redisPrefix: `rt-${id}` };
      }

      const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
      signingKey = privateKey;
      const signing = { ...(await exportJWK(privateKey)), kid: "k1", alg: "ES256", use: "sig" };
      void publicKey;
      op = createServer();
      await new Promise<void>((r) => op.listen(0, "localhost", r));
      opPort = (op.address() as AddressInfo).port;
      issuer = `http://localhost:${opPort}`;

      const file = {
        clients: [
          {
            client_id: A,
            name: "Runtime app",
            primary_domain: "rt.example",
            redirect_uris: [`${apps[A]!.base}/auth/callback`],
            post_logout_redirect_uris: [`${apps[A]!.base}/`],
            backchannel_logout_uri: `${apps[A]!.base}/auth/backchannel-logout`,
            client_secret_env: "RT_SECRET",
            admission: "public" as const,
          },
          {
            client_id: B,
            name: "Second runtime app",
            primary_domain: "rt2.example",
            redirect_uris: [`${apps[B]!.base}/auth/callback`],
            post_logout_redirect_uris: [`${apps[B]!.base}/`],
            backchannel_logout_uri: `${apps[B]!.base}/auth/backchannel-logout`,
            client_secret_env: "RT_SECRET",
            admission: "public" as const,
          },
          {
            client_id: R,
            name: "Restricted runtime app",
            primary_domain: "rtres.example",
            redirect_uris: [`${apps[R]!.base}/auth/callback`],
            post_logout_redirect_uris: [`${apps[R]!.base}/`],
            client_secret_env: "RT_SECRET",
          },
        ],
      };
      const policies = admissionPolicies(file);
      const log = createLogger((l) => process.env.IDENTITY_TEST_LOG && console.log(l));
      const late: { provider?: ReturnType<typeof createProvider> } = {};
      const signIn = createSignIn({
        issuer,
        homeUrl: `${apps[A]!.base}/`,
        apps: appLinks(file),
        admission: policies,
        otpSecret: "o".repeat(40),
        email: { mailer, dailyLimit: 10_000 },
        sms: { sender: sms, allowedPrefixes: ["+32"], dailyLimit: 1000 },
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
      provider = createProvider({
        issuer,
        jwks: { keys: [signing] },
        cookieKeys: [randomBytes(32).toString("hex")],
        clients: loadClients(file, { RT_SECRET: SECRET }, { allowLocalhost: true }),
        admission: policies,
        loginMethod: "local",
        signIn,
        trustProxy: false,
        adapter: redisAdapterFactory(redis),
        accounts: new PrincipalAccounts(store),
        readiness: async () => ({ redis: true, database: true }),
        // PURE PASSTHROUGH (see the header): oidc-provider's SSRF guard refuses loopback back-channel targets by default.
        testOnlyFetch: async (url, options) => {
          const entry: { url: string; body: string; status?: number } = {
            url: String(url),
            body: typeof options?.body === "string" ? options.body : String(options?.body ?? ""),
          };
          backchannelSent.push(entry);
          try {
            const res = await fetch(url, options as RequestInit);
            entry.status = res.status;
            return res;
          } catch (error) {
            entry.status = 0;
            throw error;
          }
        },
        log,
      });
      late.provider = provider;
      provider.on("grant.success", (ctx: { oidc: { params?: { grant_type?: string } } }) =>
        providerEvents.push({ name: "grant.success", grantType: ctx.oidc.params?.grant_type }),
      );
      provider.on("backchannel.success", () => providerEvents.push({ name: "backchannel.success" }));
      provider.on("backchannel.error", () => providerEvents.push({ name: "backchannel.error" }));
      op.on("request", provider.callback());

      for (const id of [A, B, R]) apps[id]!.auth = makeAuth(id, apps[id]!.base);
    });

    afterAll(async () => {
      op?.closeAllConnections?.();
      op?.close();
      for (const a of Object.values(apps)) {
        a.server.closeAllConnections?.();
        a.server.close();
      }
      await redis?.flushdb();
      await redis?.quit();
      await store?.close();
      await db?.end();
      await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin?.end();
    });

    // ---- browser helpers ---------------------------------------------------------------------------------------------

    async function get(url: string, jar: Jar, trail?: Trail, headers: Record<string, string> = {}) {
      const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header(), ...headers } });
      jar.take(res);
      trail?.note(res);
      return res;
    }
    async function post(url: string, jar: Jar, form: Record<string, string>, trail?: Trail, headers: Record<string, string> = {}) {
      const res = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(form),
      });
      jar.take(res);
      trail?.note(res);
      return res;
    }
    const resetLimits = async () =>
      redis.del(...(await redis.keys(`${KEY_PREFIX}sms-cd:*`)), ...(await redis.keys(`${KEY_PREFIX}sms-rl:*`)), "none");
    const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const refreshOf = (html: string) => /content="0;url=([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");

    /** The browser follows provider redirects until the app's callback, a login page, or something that is not a redirect. */
    async function followProvider(first: Response, opJar: Jar, app: App, trail: Trail) {
      let res = first;
      for (let i = 0; i < 12; i++) {
        const loc = res.headers.get("location");
        if (!loc || res.status < 300 || res.status > 399) return { res };
        const next = new URL(loc, issuer);
        if (next.href.startsWith(`${app.base}/auth/callback`)) return { res, callback: next };
        if (next.pathname === "/login" && next.searchParams.has("uid")) return { res, loginUrl: next.href };
        res = await get(next.href, opJar, trail);
      }
      throw new Error("too many redirects");
    }

    /** The e-mail code step on a login page. Returns the response of the verify step. */
    async function codeSignIn(loginUrl: string, email: string, opJar: Jar, trail: Trail) {
      await resetLimits();
      let res = await get(loginUrl, opJar, trail);
      const csrf = csrfOf(await res.text());
      res = await post(`${issuer}/login/start`, opJar, { csrf, via: "email", identifier: email }, trail);
      expect(res.status).toBe(303);
      return post(`${issuer}/login/verify`, opJar, { csrf, code: mailer.lastCode(email) }, trail);
    }

    /**
     * A whole browser sign-in through the runtime: the app's /auth/start, the provider (login page only when the provider
     * has no session for this browser), the callback on the app, and the redirect back to the return target.
     */
    async function browserSignIn(app: App, email: string, o: { opJar?: Jar; appJar?: Jar; query?: string; trail?: Trail; providerQuery?: string } = {}) {
      const opJar = o.opJar ?? new Jar();
      const appJar = o.appJar ?? new Jar();
      const trail = o.trail ?? new Trail();
      const start = await get(`${app.base}/auth/start${o.query ?? ""}`, appJar, trail);
      expect(start.status, "start").toBe(303);
      const authUrl = start.headers.get("location")! + (o.providerQuery ?? "");
      let step = await followProvider(await get(authUrl, opJar, trail), opJar, app, trail);
      let loginShown = false;
      if (step.loginUrl) {
        loginShown = true;
        const verified = await codeSignIn(step.loginUrl, email, opJar, trail);
        let location: string | undefined;
        if (verified.status === 200) location = refreshOf(await verified.text());
        else if (verified.status === 303) location = verified.headers.get("location") ?? undefined;
        let callback: URL | undefined;
        for (let i = 0; i < 10 && location; i++) {
          const next = new URL(location, issuer);
          if (next.href.startsWith(`${app.base}/auth/callback`)) {
            callback = next;
            break;
          }
          const r = await get(next.href, opJar, trail);
          location = r.headers.get("location") ?? undefined;
          step = { res: r } as typeof step;
        }
        step = { res: verified, callback } as typeof step;
      }
      const callback = (step as { callback?: URL }).callback;
      if (!callback) return { loginShown, callback: undefined as URL | undefined, session: undefined as string | undefined, appJar, opJar, trail, final: undefined as Response | undefined };
      const final = await get(callback.href, appJar, trail);
      return { loginShown, callback, session: appJar.get("__Host-asafarim.sid"), appJar, opJar, trail, final };
    }

    const sessionOf = (appJar: Jar) => appJar.get("__Host-asafarim.sid");
    const reqWith = (appJar: Jar, url = "http://localhost/") => new Request(url, { headers: { cookie: appJar.header() } });
    const issuedTokens = async (app: App, appJar: Jar) => {
      const h = await app.auth.current(reqWith(appJar), { touch: false });
      return { access: h!.accessToken(), handle: h! };
    };

    // ---- 1. login ------------------------------------------------------------------------------------------------------

    it("1. login: the runtime starts the code flow, the real provider authenticates an e-mail code, the runtime validates the tokens and opens a host-only session", async () => {
      const email = "login-1@example.test";
      const r = await browserSignIn(apps[A]!, email, { query: "?return=%2Fwelcome%3Fa%3D1" });
      expect(r.loginShown).toBe(true);
      expect(r.callback).toBeDefined();
      expect(r.final!.status).toBe(303);
      expect(r.final!.headers.get("location")).toBe(`${apps[A]!.base}/welcome?a=1`);

      // The session cookie is host-only (__Host-, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain).
      const set = r.final!.headers.getSetCookie().find((c) => c.startsWith("__Host-asafarim.sid="))!;
      expect(set).toMatch(/^__Host-asafarim\.sid=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);

      // What the runtime validated from the real ID token.
      const { access, handle } = await issuedTokens(apps[A]!, r.appJar);
      const principal = (await db.query("SELECT principal_id FROM identities WHERE method = 'email' AND identifier = $1", [email])).rows[0]
        .principal_id as string;
      expect(handle.view.identityKey).toEqual({ iss: issuer, sub: principal });
      expect(handle.view.emailHint).toBe(email);
      const nowSec = Math.floor(Date.now() / 1000);
      expect(Math.abs(handle.view.authTime - nowSec)).toBeLessThan(30); // auth_time from the verified ID token
      expect(handle.view.sid).toBeTruthy();
      // The provider does not emit amr/acr today: the runtime carries them only if the verified ID token has them.
      expect(handle.view.amr).toBeUndefined();
      expect(handle.view.acr).toBeUndefined();

      // Confidentiality: no token, authorization code or session id anywhere the browser (or a log line) went.
      const seen = r.trail.text();
      const refresh = await redis.keys("rt-rtapp:*"); // keys exist, and none is the cookie value
      expect(refresh.length).toBeGreaterThan(0);
      expect(refresh.join("\n")).not.toContain(sessionOf(r.appJar)!);
      for (const secret of [access, r.callback!.searchParams.get("code")!]) {
        // the authorization code is allowed in exactly one place: the callback URL the provider sent the browser to
        const count = seen.split(secret).length - 1;
        expect(count, secret === access ? "access token" : "code").toBe(secret === access ? 0 : 2);
      }
      expect([logLines.join("\n"), auditLines.join("\n")].join("\n")).not.toContain(access);
    });

    it("1b. Auth.js adapter config compatibility (labelled config compatibility, not a login): the provider block is accepted by openid-client for discovery and PKCE against the real provider", async () => {
      const cfg = asafarimAuthConfig({ issuer, clientId: A, clientSecret: SECRET, secret: "s" });
      const p = cfg.providers[0]!;
      expect(p.issuer).toBe(issuer);
      const config = await oidcClient.discovery(new URL(p.issuer), p.clientId, { token_endpoint_auth_method: p.client.token_endpoint_auth_method, id_token_signed_response_alg: "ES256" }, oidcClient.ClientSecretBasic(SECRET), {
        execute: [oidcClient.allowInsecureRequests],
      });
      expect(config.serverMetadata().code_challenge_methods_supported).toContain("S256");
      expect(p.checks).toEqual(["pkce", "state", "nonce"]);
      const verifier = oidcClient.randomPKCECodeVerifier();
      const url = oidcClient.buildAuthorizationUrl(config, {
        redirect_uri: `${apps[A]!.base}/auth/callback`,
        scope: p.authorization.params.scope,
        state: oidcClient.randomState(),
        nonce: oidcClient.randomNonce(),
        code_challenge: await oidcClient.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      // The real provider accepts this request shape: it answers with an interaction redirect, not an error page.
      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!, issuer).pathname).toMatch(/^\/(interaction|auth)\//);
    });
  });
}

// Keep references the later sections use.
void [createHash, SignJWT, StepUpRequiredError, IdentityUnavailableError, StoreUnavailableError, createSessionStateHandler, notifySessionLogout, managementForUnused()];
function managementForUnused() {
  return 0;
}
