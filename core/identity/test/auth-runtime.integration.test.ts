/**
 * @asafarim/auth-runtime against the REAL identity provider (S2, #344): `createProvider` (oidc-provider), the real
 * sign-in routes, Postgres (PgIdentityStore + PrincipalAccounts), Redis (provider adapter AND the runtime's Redis store)
 * and real HTTP listeners, one per "app" running the runtime's plain Node adapter. There are no provider mocks.
 *
 * What is NOT real, said plainly:
 *  - the mail transport (CapturingMailer: the e-mail code is read from the captured message, as the other identity
 *    integration tests do);
 *  - `testOnlyFetch`: oidc-provider refuses back-channel targets on loopback addresses (its SSRF guard is a custom undici
 *    `dispatcher` it puts in the request options), so the provider is given a PASSTHROUGH fetch: it records the request and
 *    forwards method, headers and body unchanged to the app's listener, dropping ONLY that guard dispatcher. It rewrites
 *    nothing and signs nothing; the logout tokens are produced and signed by oidc-provider;
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  describe("auth-runtime against the real provider: createProvider + Postgres + Redis + HTTP", { timeout: 30_000 }, () => {
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
        afterSignIn: ({ locale, intent }) => [
          ...(locale ? [`app-locale=${locale}; Path=/; Secure; HttpOnly; SameSite=Lax`] : []),
          ...(intent ? [`app-intent=${intent}; Path=/; Secure; HttpOnly; SameSite=Lax`] : []),
        ],
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
        // As server.ts wires it: end the provider sessions and revoke their grants, then notify each app's back-channel.
        endProviderSessions: (id) =>
          endSessionsOfAccount(redis, id, async (ended) => {
            if (late.provider) await notifySessionLogout(late.provider, ended, log);
          }),
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
            // Only oidc-provider's SSRF-guarding `dispatcher` is dropped (it refuses loopback); method, headers and body go through unchanged.
            const { dispatcher: _guard, ...forwarded } = (options ?? {}) as RequestInit & { dispatcher?: unknown };
            void _guard;
            const res = await fetch(url, forwarded);
            entry.status = res.status;
            return res;
          } catch (error) {
            entry.status = 0;
            if (process.env.RT_DEBUG) console.log("PASSTHROUGH ERROR", error, options);
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
    async function codeSignIn(loginUrl: string, email: string, opJar: Jar, trail: Trail, extra: { form?: Record<string, string>; headers?: Record<string, string> } = {}) {
      await resetLimits();
      let res = await get(loginUrl, opJar, trail, extra.headers);
      const csrf = csrfOf(await res.text());
      res = await post(`${issuer}/login/start`, opJar, { csrf, via: "email", identifier: email, ...extra.form }, trail, extra.headers);
      expect(res.status).toBe(303);
      return post(`${issuer}/login/verify`, opJar, { csrf, code: mailer.lastCode(email), ...extra.form }, trail, extra.headers);
    }

    /**
     * A whole browser sign-in through the runtime: the app's /auth/start, the provider (login page only when the provider
     * has no session for this browser), the callback on the app, and the redirect back to the return target.
     */
    async function browserSignIn(
      app: App,
      email: string,
      o: { opJar?: Jar; appJar?: Jar; query?: string; trail?: Trail; providerQuery?: string; extra?: { form?: Record<string, string>; headers?: Record<string, string> } } = {},
    ) {
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
        const verified = await codeSignIn(step.loginUrl, email, opJar, trail, o.extra);
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
      if (!callback) return { loginShown, authUrl, callback: undefined as URL | undefined, session: undefined as string | undefined, appJar, opJar, trail, final: undefined as Response | undefined };
      const final = await get(callback.href, appJar, trail);
      return { loginShown, authUrl, callback, session: appJar.get("__Host-asafarim.sid"), appJar, opJar, trail, final };
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

    // ---- helpers for the scenarios below ---------------------------------------------------------------------------------

    /** Read a session record straight from the runtime's Redis store (tests only: tokens never leave the server). */
    const peekStore = (app: App) => createRedisStore({ redis, secret: STORE_SECRET, prefix: app.redisPrefix });
    async function peek(app: App, appJar: Jar) {
      const r = await peekStore(app).get(sessionOf(appJar)!, { touch: false, idleMs: null, now: clock.now() });
      if (r.status !== "ok") throw new Error(`no session: ${r.status}`);
      return r.session;
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const refreshGrants = () => providerEvents.filter((e) => e.name === "grant.success" && e.grantType === "refresh_token").length;
    const principalOf = async (email: string) =>
      (await db.query("SELECT principal_id FROM identities WHERE method = 'email' AND identifier = $1", [email])).rows[0]?.principal_id as string;

    beforeEach(() => {
      clock.offset = 0;
      delayTokenMs = 0;
      transport.down = false;
    });

    // ---- 2. refresh with a race ----------------------------------------------------------------------------------------------

    it("2. refresh: ten concurrent requests after the access token expired cause exactly ONE refresh grant at the provider, and rotation stays valid", async () => {
      const app = apps[A]!;
      const r = await browserSignIn(app, "refresh-2@example.test");
      const first = await peek(app, r.appJar);
      expect(first.refreshToken).toBeTruthy();

      clock.offset = 11 * 60_000; // the access token (10 min) has expired as far as the runtime can tell
      delayTokenMs = 200; // hold the refresh open so the other nine really contend for the lock
      const grantsBefore = refreshGrants();
      const handles = await Promise.all(Array.from({ length: 10 }, () => app.auth.current(reqWith(r.appJar), { touch: false })));
      expect(refreshGrants() - grantsBefore, "refresh grants counted from oidc-provider's own grant.success events").toBe(1);
      expect(handles.every((h) => h !== null)).toBe(true);
      const second = await peek(app, r.appJar);
      expect(second.refreshToken).not.toBe(first.refreshToken); // rotated
      expect(second.accessToken).not.toBe(first.accessToken);
      expect(new Set(handles.map((h) => h!.accessToken())).size).toBe(1);
      expect(handles[0]!.accessToken()).toBe(second.accessToken);

      // The grant was not revoked by reuse detection: the new access token works and a second rotation succeeds.
      expect((await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${second.accessToken}` } })).status).toBe(200);
      delayTokenMs = 0;
      clock.offset = 22 * 60_000;
      expect(await app.auth.current(reqWith(r.appJar), { touch: false })).not.toBeNull();
      expect(refreshGrants() - grantsBefore).toBe(2);
    });

    it("2b. refresh lease: a refresh result is NOT saved after the lock was lost, and the stale record is left untouched", async () => {
      const app = apps[A]!;
      const r = await browserSignIn(app, "refresh-2b@example.test");
      const before = await peek(app, r.appJar);
      clock.offset = 11 * 60_000;
      delayTokenMs = 400; // longer than a lease renewal interval (5000/3 ms is too long for a test, so shorten the lease)
      const shortLease = makeAuth(A, app.base, { bounds: { ...BOUNDS, refreshLeaseMs: 90 }, prefix: app.redisPrefix });
      const pending = shortLease.current(reqWith(r.appJar), { touch: false }).then(
        (h) => ({ ok: true as const, h }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      await sleep(120); // the first lease renewal has happened; now another process "takes over": the lock key vanishes
      const lockKeys = await redis.keys(`${app.redisPrefix}:l:*`);
      expect(lockKeys.length).toBe(1);
      await redis.del(...lockKeys);
      const out = await pending;
      expect(out.ok).toBe(false);
      expect((out as { e: AuthRuntimeError }).e).toMatchObject({ code: "refresh_ownership_lost" });
      const after = await peek(app, r.appJar);
      expect(after.accessToken).toBe(before.accessToken); // nothing was saved
      expect(after.refreshToken).toBe(before.refreshToken);
      // The provider DID rotate: the saved refresh token is now spent. The next refresh is rejected and ends the session:
      // the documented hazard of losing a lock mid-grant, and why the lease is renewed.
      delayTokenMs = 0;
      clock.offset = 22 * 60_000;
      expect(await app.auth.current(reqWith(r.appJar), { touch: false })).toBeNull();
    });

    // ---- 3. userinfo and freshness -----------------------------------------------------------------------------------

    it("3a. userinfo: an access token that belongs to another person than the stored subject ends the session", async () => {
      const app = apps[A]!;
      const mine = await browserSignIn(app, "userinfo-3a@example.test");
      const other = await browserSignIn(app, "userinfo-3a-other@example.test");
      const s = await peek(app, mine.appJar);
      const theirs = await peek(app, other.appJar);
      const st = peekStore(app);
      const id = sessionOf(mine.appJar)!;
      const lock = (await st.acquireRefresh(id, 5000))!;
      expect(await st.update(id, { ...s, accessToken: theirs.accessToken }, lock, { now: clock.now() })).toBe(true);
      await st.releaseRefresh(id, lock);
      // Inside the re-check window nothing is asked of the provider; after it, userinfo answers with the OTHER subject.
      expect(await app.auth.current(reqWith(mine.appJar), { touch: false })).not.toBeNull();
      clock.offset = BOUNDS.revalidateMs + 1000;
      expect(await app.auth.current(reqWith(mine.appJar), { touch: false })).toBeNull();
      expect((await st.get(id, { touch: false, idleMs: null, now: clock.now() })).status).toBe("missing"); // destroyed
      expect(await app.auth.current(reqWith(other.appJar), { touch: false })).not.toBeNull(); // the other person is untouched
    });

    it("3a-ii. the Redis record fails closed when it was tampered with (metadata cross-check), never serving a changed identity", async () => {
      const app = apps[A]!;
      const r = await browserSignIn(app, "tamper-3a@example.test");
      const s = await peek(app, r.appJar);
      const st = peekStore(app);
      const id = sessionOf(r.appJar)!;
      const lock = (await st.acquireRefresh(id, 5000))!;
      await st.update(id, { ...s, identityKey: { ...s.identityKey, sub: "someone-else" } }, lock, { now: clock.now() });
      await st.releaseRefresh(id, lock);
      await expect(app.auth.current(reqWith(r.appJar), { touch: false })).rejects.toMatchObject({ code: "store_corrupt" });
    });

    /** Stand in for the passage of time at the PROVIDER (which keeps real time): age every identity auth session of a person. */
    async function ageIdentitySessions(principalId: string, seconds: number) {
      const hashes = await redis.smembers(`${KEY_PREFIX}sms-sessions-of:${principalId}`);
      expect(hashes.length).toBeGreaterThan(0);
      for (const hash of hashes) {
        const key = `${KEY_PREFIX}sms-session:${hash}`;
        const raw = await redis.get(key);
        if (!raw) continue;
        const rec = JSON.parse(raw) as { authTime: number };
        await redis.set(key, JSON.stringify({ ...rec, authTime: rec.authTime - seconds }), "KEEPTTL");
      }
    }

    it("3b. step-up: a stale auth_time is refused with a restart URL; prompt=login at the real provider yields a fresh auth_time and replaces the session", async () => {
      const app = apps[A]!;
      const stepAuth = makeAuth(A, app.base, { bounds: { ...BOUNDS, freshMs: 3000 }, prefix: "rt-step" });
      const original = app.auth;
      app.auth = stepAuth;
      try {
        const email = "stepup-3b@example.test";
        const r = await browserSignIn(app, email);
        expect((await stepAuth.state(reqWith(r.appJar))).fresh).toBe(true);
        await expect(stepAuth.require(reqWith(r.appJar), { fresh: true })).resolves.toBeTruthy();
        const oldSession = sessionOf(r.appJar)!;
        const oldAuthTime = (await stepAuth.current(reqWith(r.appJar), { touch: false }))!.view.authTime;

        await sleep(3400);
        const err = await stepAuth.require(reqWith(r.appJar), { fresh: true, returnTo: "/billing" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StepUpRequiredError);
        const restart = (err as StepUpRequiredError).restartUrl!;
        expect(restart).toBe("/auth/start?return=%2Fbilling&fresh=1");
        expect((await stepAuth.state(reqWith(r.appJar))).fresh).toBe(false);
        await expect(stepAuth.require(reqWith(r.appJar))).resolves.toBeTruthy(); // non-fresh actions are unaffected

        // The provider also considers the sign-in old (identity answers prompt=login from its own session only within 120 s).
        await ageIdentitySessions(await principalOf(email), 600);
        // The browser follows the restart URL. The provider still has this browser's session, yet prompt=login makes it ask again.
        const again = await browserSignIn(app, email, { opJar: r.opJar, appJar: r.appJar, query: restart.replace("/auth/start", "") });
        expect(again.loginShown, "the provider asked for credentials again (prompt=login)").toBe(true);
        expect(again.final!.headers.get("location")).toBe(`${app.base}/billing`);
        const fresh = await stepAuth.current(reqWith(again.appJar), { touch: false });
        expect(fresh!.view.authTime).toBeGreaterThan(oldAuthTime);
        expect(fresh!.fresh).toBe(true);
        await expect(stepAuth.require(reqWith(again.appJar), { fresh: true })).resolves.toBeTruthy();
        expect(sessionOf(again.appJar)).not.toBe(oldSession); // new id, no fixation
        const oldJar = new Jar();
        oldJar.take(new Response(null, { headers: { "set-cookie": `__Host-asafarim.sid=${oldSession}` } }));
        expect(await stepAuth.current(reqWith(oldJar), { touch: false })).toBeNull(); // the previous session was ended
      } finally {
        app.auth = original;
      }
    });

    it("3c. the browser's ?fresh=1 is a request, not evidence: when the provider answers from its own older session, the runtime re-checks auth_time and refuses", async () => {
      const app = apps[A]!;
      const stepAuth = makeAuth(A, app.base, { bounds: { ...BOUNDS, freshMs: 3000 }, prefix: "rt-step" });
      const original = app.auth;
      app.auth = stepAuth;
      try {
        const email = "stepup-3c@example.test";
        const r = await browserSignIn(app, email);
        await sleep(3400);
        // identity reuses a login younger than 120 s even for prompt=login, so the ID token carries the OLD auth_time.
        const again = await browserSignIn(app, email, { opJar: r.opJar, appJar: r.appJar, query: "?fresh=1" });
        expect(again.loginShown).toBe(false);
        expect(again.final!.status).toBe(401);
        expect(await again.final!.text()).toBe("Sign-in problem (step_up_required).");
        expect(again.final!.headers.getSetCookie().some((c) => c.startsWith("__Host-asafarim.sid=") && !c.includes("Max-Age=0"))).toBe(false);
      } finally {
        app.auth = original;
      }
    });

    // ---- 4. back-channel logout, really emitted ------------------------------------------------------------------------

    const EVENT = "http://schemas.openid.net/event/backchannel-logout";
    const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000) {
      const t0 = Date.now();
      while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(25);
      }
    }
    const postBackchannel = (app: App, logoutToken: string) =>
      fetch(`${app.base}/auth/backchannel-logout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ logout_token: logoutToken }),
      });
    /** CRAFTED: signed with the provider's own test signing key, for cases a real provider never emits. */
    async function crafted(claims: Record<string, unknown>) {
      const base = { iss: issuer, aud: A, iat: Math.floor(Date.now() / 1000), jti: randomBytes(12).toString("hex"), events: { [EVENT]: {} }, ...claims };
      const jwt = new SignJWT(base as Record<string, unknown>).setProtectedHeader({ alg: "ES256", kid: "k1", typ: "logout+jwt" });
      return jwt.sign(signingKey);
    }

    it("4. back-channel logout: the logout tokens are emitted by oidc-provider on a real RP-initiated logout; the runtime validates them, revokes both apps' sessions, and refuses replays and crafted variants", async () => {
      const email = "bcl-4@example.test";
      const opJar = new Jar();
      const a = await browserSignIn(apps[A]!, email, { opJar });
      expect(a.loginShown).toBe(true);
      // 8a. SSO: the second app gets a session from the provider's existing session, with no credential prompt.
      const b = await browserSignIn(apps[B]!, email, { opJar });
      expect(b.loginShown, "an existing identity session gives a new app session with no sign-in step").toBe(false);
      expect(b.session).toBeTruthy();
      const sa = await peek(apps[A]!, a.appJar);
      const sb = await peek(apps[B]!, b.appJar);
      expect(sb.identityKey).toEqual(sa.identityKey); // one account across both apps
      expect(sa.sid).toBeTruthy();

      const from = backchannelSent.length;
      const end = await get(`${issuer}/session/end?client_id=${A}&post_logout_redirect_uri=${encodeURIComponent(`${apps[A]!.base}/`)}`, opJar);
      expect(end.status).toBe(200);
      const html = await end.text();
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)![1]!;
      const action = /action="([^"]+)"/.exec(html)![1]!;
      const confirm = await post(new URL(action, issuer).href, opJar, { xsrf, logout: "yes" });
      expect([200, 302, 303]).toContain(confirm.status);

      await until(() => backchannelSent.slice(from).filter((e) => e.status !== undefined).length >= 2, "two back-channel deliveries");
      const sent = backchannelSent.slice(from);
      expect(sent.map((e) => e.url).sort()).toEqual([`${apps[A]!.base}/auth/backchannel-logout`, `${apps[B]!.base}/auth/backchannel-logout`].sort());
      expect(sent.map((e) => e.status)).toEqual([200, 200]);
      expect(providerEvents.filter((e) => e.name === "backchannel.success").length).toBeGreaterThanOrEqual(2);

      // The tokens are the provider's own: issuer, audience per app, the event, a jti, the session id, and no nonce.
      for (const e of sent) {
        const token = new URLSearchParams(e.body).get("logout_token")!;
        const claims = decode(token);
        expect(claims.iss).toBe(issuer);
        expect([A, B]).toContain(claims.aud);
        expect(claims.events).toEqual({ [EVENT]: {} });
        expect(claims.nonce).toBeUndefined();
        expect(typeof claims.jti).toBe("string");
        expect(claims.sid).toBeTruthy();
      }
      // Consumer invalidation: both apps' sessions are gone.
      expect(await apps[A]!.auth.current(reqWith(a.appJar), { touch: false })).toBeNull();
      expect(await apps[B]!.auth.current(reqWith(b.appJar), { touch: false })).toBeNull();

      // Replay: the exact request, again, is refused.
      const entryA = sent.find((e) => e.url.startsWith(apps[A]!.base))!;
      const replay = await fetch(entryA.url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: entryA.body });
      expect(replay.status).toBe(400);

      // Crafted variants against a LIVE session: every one is refused, the control is accepted, so the refusals are for their reason.
      const live = await browserSignIn(apps[A]!, "bcl-4-live@example.test");
      const liveSession = await peek(apps[A]!, live.appJar);
      const good = { sid: liveSession.sid };
      const nowSec = Math.floor(Date.now() / 1000);
      const negatives: [string, Record<string, unknown>][] = [
        ["wrong audience", { ...good, aud: B }],
        ["wrong issuer", { ...good, iss: "http://localhost:1" }],
        ["has a nonce", { ...good, nonce: "n" }],
        ["no events", { ...good, events: undefined }],
        ["wrong event", { ...good, events: { "http://schemas.openid.net/event/other": {} } }],
        ["issued 5 minutes ago", { ...good, iat: nowSec - 300 }],
        ["issued in the future", { ...good, iat: nowSec + 600 }],
        ["no sid or sub", { sid: undefined }],
        ["no jti", { ...good, jti: undefined }],
      ];
      for (const [label, claims] of negatives) {
        const res = await postBackchannel(apps[A]!, await crafted(claims));
        expect(res.status, `crafted: ${label}`).toBe(400);
      }
      // signed by a key the provider does not publish
      const stranger = await generateKeyPair("ES256");
      const bad = await new SignJWT({ iss: issuer, aud: A, iat: nowSec, jti: "x".repeat(10), sid: liveSession.sid, events: { [EVENT]: {} } })
        .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "logout+jwt" })
        .sign(stranger.privateKey);
      expect((await postBackchannel(apps[A]!, bad)).status, "crafted: signed by another key").toBe(400);
      expect(await apps[A]!.auth.current(reqWith(live.appJar), { touch: false })).not.toBeNull(); // none of that did anything
      const control = await postBackchannel(apps[A]!, await crafted(good));
      expect(control.status, "crafted control: same construction, valid claims").toBe(200);
      expect(await apps[A]!.auth.current(reqWith(live.appJar), { touch: false })).toBeNull();
    });

    it("4b. missed back-channel delivery: with the app unreachable the provider logs and moves on (it does not retry); the session still ends by the next provider re-check", async () => {
      const app = apps[A]!;
      const email = "bcl-4b@example.test";
      const r = await browserSignIn(app, email);
      const principal = await principalOf(email);
      const port = Number(new URL(app.base).port);
      const from = backchannelSent.length;
      const errorsBefore = providerEvents.filter((e) => e.name === "backchannel.error").length;
      app.server.closeAllConnections();
      await new Promise<void>((res) => app.server.close(() => res()));
      try {
        // The production revocation path: end the provider sessions, revoke their grants, then notify (delivery fails).
        await endSessionsOfAccount(redis, principal, (ended) => notifySessionLogout(provider, ended));
        await until(() => backchannelSent.slice(from).some((e) => e.url.startsWith(app.base) && e.status === 0), "the provider's failed delivery attempt");
        const attempts = backchannelSent.slice(from).filter((e) => e.url.startsWith(app.base));
        expect(attempts).toHaveLength(1); // one attempt, no retry
        expect(attempts[0]!.status).toBe(0);
      } finally {
        app.server = createServer(appHandler(A));
        await new Promise<void>((res) => app.server.listen(port, "localhost", res));
      }
      // The runtime was never told. Within its re-check window it still serves (the stated bound); past it, the provider says no.
      clock.offset = BOUNDS.revalidateMs - 5000;
      expect(await app.auth.current(reqWith(r.appJar), { touch: false })).not.toBeNull();
      clock.offset = BOUNDS.revalidateMs + 1000;
      expect(await app.auth.current(reqWith(r.appJar), { touch: false })).toBeNull();
      void errorsBefore;
    });
  });
}

// Keep references the later sections use.
void [createHash, SignJWT, StepUpRequiredError, IdentityUnavailableError, StoreUnavailableError, createSessionStateHandler, notifySessionLogout, managementForUnused()];
function managementForUnused() {
  return 0;
}
