/**
 * End to end over HTTP: the real provider, a real (test) Redis, a stub Hub that
 * signs assertions with its own Ed25519 key, an in-memory account view, and a
 * stub client that receives back-channel logouts.
 *
 * Needs IDENTITY_TEST_REDIS_URL (CI sets it; locally e.g.
 * `docker run -d -p 127.0.0.1:56390:6379 redis:7-alpine` and
 * IDENTITY_TEST_REDIS_URL=redis://127.0.0.1:56390/15). The DB is flushed.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { SignJWT, createRemoteJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, AccountStore } from "../src/accounts.ts";
import { loadClients } from "../src/clients.ts";
import { ASSERTION_AUDIENCE, ASSERTION_ISSUER, verifyTicket } from "../src/handoff.ts";
import { createLogger } from "../src/log.ts";
import { createProvider } from "../src/provider.ts";
import { RedisPendingLogins } from "../src/pending.ts";
import { RedisReplayGuard, redisAdapterFactory } from "../src/redis-adapter.ts";

const REDIS_URL = process.env.IDENTITY_TEST_REDIS_URL;
// CI must run these, never skip them silently.
if (process.env.CI && !REDIS_URL) throw new Error("IDENTITY_TEST_REDIS_URL must be set in CI");
const SECRET = randomBytes(32).toString("base64url");
const CLIENT_ID = "demo";

class MemoryAccounts implements AccountStore {
  readonly rows = new Map<string, Account>();
  async find(sub: string) {
    return this.rows.get(sub) ?? null;
  }
  async ping() {}
  async close() {}
}

/** A tiny cookie jar: enough for oidc-provider's signed cookies. */
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

describe.skipIf(!REDIS_URL)("identity service, end to end (Redis + stub Hub + stub client)", () => {
  let redis: Redis;
  let op: Server;
  let rp: Server;
  let issuer: string;
  let rpBase: string;
  let hubKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let identityHandoff: Awaited<ReturnType<typeof generateKeyPair>>;
  const accounts = new MemoryAccounts();
  const backchannel: string[] = [];
  const log = createLogger((l) => process.env.IDENTITY_TEST_LOG && console.log(l));

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!);
    await redis.flushdb();

    rp = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/bcl") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          backchannel.push(new URLSearchParams(body).get("logout_token") ?? "");
          res.statusCode = 200;
          res.end();
        });
        return;
      }
      res.statusCode = 200;
      res.end("rp");
    });
    await new Promise<void>((r) => rp.listen(0, r));
    rpBase = `http://localhost:${(rp.address() as AddressInfo).port}`;

    hubKeys = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    identityHandoff = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const signing = { ...(await exportJWK(privateKey)), kid: "k1", alg: "ES256", use: "sig" };

    op = createServer();
    await new Promise<void>((r) => op.listen(0, r));
    issuer = `http://localhost:${(op.address() as AddressInfo).port}`;

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
              post_logout_redirect_uris: [`${rpBase}/bye`],
              backchannel_logout_uri: `${rpBase}/bcl`,
              client_secret_env: "DEMO_SECRET",
            },
          ],
        },
        { DEMO_SECRET: SECRET },
        { allowLocalhost: true },
      ),
      handoffPrivateKey: identityHandoff.privateKey,
      hubPublicKey: hubKeys.publicKey,
      hubContinueUrl: "http://localhost:1/oidc/continue",
      trustProxy: false,
      adapter: redisAdapterFactory(redis),
      accounts,
      replay: new RedisReplayGuard(redis),
      pending: new RedisPendingLogins(redis),
      readiness: async () => ({ redis: (await redis.ping()) === "PONG", database: true }),
      log,
      // oidc-provider refuses outbound requests to loopback (SSRF protection);
      // the stub client lives on localhost, so drop that dispatcher here only.
      testOnlyFetch: (url, options) => {
        const { dispatcher: _ssrfGuard, ...rest } = options as RequestInit & { dispatcher?: unknown };
        return fetch(url, rest);
      },
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

  function authUrl(params: Record<string, string>) {
    const u = new URL(`${issuer}/auth`);
    for (const [k, v] of Object.entries({
      client_id: CLIENT_ID,
      redirect_uri: `${rpBase}/cb`,
      response_type: "code",
      scope: "openid email profile roles",
      state: "st",
      nonce: "nn",
      ...params,
    }))
      if (v !== "") u.searchParams.set(k, v);
    return u.href;
  }

  async function get(url: string, jar: Jar) {
    const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header() } });
    jar.take(res);
    return res;
  }

  async function hubAssertion(sub: string, uid: string, over: Record<string, unknown> = {}) {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ uid, ...over })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(ASSERTION_ISSUER)
      .setAudience(ASSERTION_AUDIENCE)
      .setSubject(sub)
      .setJti(randomBytes(12).toString("base64url"))
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(hubKeys.privateKey);
  }

  /**
   * Hub's auto-submitted POST: cross-site, so the browser sends no identity
   * (SameSite=Lax) cookies, but it does store the cookies the response sets.
   */
  async function postAssertion(uid: string, assertion: string, jar?: Jar) {
    const res = await fetch(`${issuer}/interaction/${uid}/hub`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ assertion }),
    });
    jar?.take(res);
    return res;
  }

  /** Start an interaction in `jar`'s browser; returns its uid. */
  async function start(jar: Jar) {
    let res = await get(authUrl({ code_challenge: pkce().challenge, code_challenge_method: "S256" }), jar);
    const interaction = new URL(res.headers.get("location")!, issuer);
    res = await get(interaction.href, jar);
    expect(res.status).toBe(302); // → Hub, with a ticket
    return interaction.pathname.split("/").pop()!;
  }

  /** Walk the browser side of a sign-in up to the client's callback. */
  async function signIn(sub: string, params: Record<string, string>) {
    const jar = new Jar();
    let res = await get(authUrl(params), jar);
    expect(res.status).toBe(303);
    const interaction = new URL(res.headers.get("location")!, issuer);
    const uid = interaction.pathname.split("/").pop()!;

    res = await get(interaction.href, jar);
    expect(res.status).toBe(302);
    const toHub = new URL(res.headers.get("location")!);
    expect(toHub.origin + toHub.pathname).toBe("http://localhost:1/oidc/continue");
    const ticket = await verifyTicket(toHub.searchParams.get("ticket")!, identityHandoff.publicKey);
    expect(ticket.uid).toBe(uid);

    res = await postAssertion(uid, await hubAssertion(sub, uid), jar);
    if (res.status !== 303) return { res, jar, uid };
    expect(res.headers.get("location")).toBe(`/interaction/${uid}/complete`);

    // Follow the provider's redirects (resume, possibly consent) to the callback.
    let location = new URL(res.headers.get("location")!, issuer).href;
    for (let i = 0; i < 6 && !location.startsWith(`${rpBase}/cb`); i++) {
      res = await get(location, jar);
      location = new URL(res.headers.get("location")!, issuer).href;
    }
    return { res, jar, uid, callback: new URL(location) };
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

  it("serves discovery, JWKS and health", async () => {
    const d = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(d.issuer).toBe(issuer);
    expect(d.response_types_supported).toEqual(["code"]);
    expect(d.code_challenge_methods_supported).toEqual(["S256"]);
    expect(d.id_token_signing_alg_values_supported).toEqual(["ES256"]);
    expect(d.backchannel_logout_supported).toBe(true);
    expect(d.end_session_endpoint).toBeTruthy();
    const jwks = (await (await fetch(d.jwks_uri as string)).json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys.map((k) => [k.kid, k.d])).toEqual([["k1", undefined]]);
    expect((await fetch(`${issuer}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${issuer}/readyz`)).json()).toEqual({
      ok: true,
      checks: { redis: true, database: true },
    });
  });

  it("code + PKCE → an ES256 ID token, a 10 min access token and userinfo claims", async () => {
    accounts.rows.set("u-1", {
      sub: "u-1",
      email: "u1@example.test",
      name: "User One",
      picture: null,
      roles: ["tester"],
      isActive: true,
    });
    const { verifier, challenge } = pkce();
    const { callback } = await signIn("u-1", { code_challenge: challenge, code_challenge_method: "S256" });
    expect(callback!.searchParams.get("state")).toBe("st");
    const code = callback!.searchParams.get("code")!;

    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${rpBase}/cb`,
      code_verifier: verifier,
    });
    expect(t.status).toBe(200);
    expect(t.json.expires_in).toBe(600);
    expect(t.json.refresh_token).toBeUndefined(); // no offline_access → no refresh token

    const { payload, protectedHeader } = await jwtVerify(
      t.json.id_token as string,
      createRemoteJWKSet(new URL(`${issuer}/jwks`)),
      {
        issuer,
        audience: CLIENT_ID,
      },
    );
    expect(protectedHeader.alg).toBe("ES256");
    expect(payload).toMatchObject({ sub: "u-1", nonce: "nn" });

    const ui = await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${t.json.access_token}` } });
    expect(await ui.json()).toEqual({ sub: "u-1", email: "u1@example.test", name: "User One", roles: ["tester"] });

    // A code is single-use.
    expect(
      (await token({ grant_type: "authorization_code", code, redirect_uri: `${rpBase}/cb`, code_verifier: verifier }))
        .json.error,
    ).toBe("invalid_grant");
  });

  it("refuses an authorization request without PKCE, or with plain PKCE", async () => {
    const cases: Record<string, string>[] = [{}, { code_challenge: "a".repeat(43), code_challenge_method: "plain" }];
    for (const params of cases) {
      const res = await get(authUrl(params), new Jar());
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe(`${rpBase}/cb`);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
    }
  });

  it("refuses an unknown redirect URI with the error page, never a redirect", async () => {
    const res = await get(
      authUrl({
        redirect_uri: "https://evil.example/cb",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
      new Jar(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("ASafariM");
    expect(html).toContain("invalid_redirect_uri");
  });

  it("refuses an inactive account: error page, no login, no code", async () => {
    accounts.rows.set("u-off", { sub: "u-off", email: null, name: null, picture: null, roles: [], isActive: false });
    const { res } = await signIn("u-off", { code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("account_inactive");
  });

  it("refuses a replayed, misdirected or foreign-signed assertion over HTTP", async () => {
    accounts.rows.set("u-2", { sub: "u-2", email: null, name: null, picture: null, roles: [], isActive: true });
    const jar = new Jar();
    let res = await get(authUrl({ code_challenge: pkce().challenge, code_challenge_method: "S256" }), jar);
    const uid = new URL(res.headers.get("location")!, issuer).pathname.split("/").pop()!;

    const forged = await new SignJWT({ uid })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(ASSERTION_ISSUER)
      .setAudience(ASSERTION_AUDIENCE)
      .setSubject("u-2")
      .setJti("j")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign((await generateKeyPair("EdDSA", { crv: "Ed25519" })).privateKey);
    res = await postAssertion(uid, forged);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("assertion_bad_signature");

    res = await postAssertion(uid, await hubAssertion("u-2", "some-other-uid"));
    expect(await res.text()).toContain("assertion_wrong_uid");

    const good = await hubAssertion("u-2", uid);
    expect((await postAssertion(uid, good)).status).toBe(303);
    res = await postAssertion(uid, good);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("assertion_replayed");
  });

  it("refuses to finish an interaction in a browser other than the one that started it (swap)", async () => {
    accounts.rows.set("victim", { sub: "victim", email: null, name: null, picture: null, roles: [], isActive: true });
    accounts.rows.set("other", { sub: "other", email: null, name: null, picture: null, roles: [], isActive: true });

    // Browser A starts the interaction; browser B (signed in to Hub as
    // "other") opens A's continue link and posts the assertion.
    const a = new Jar();
    const b = new Jar();
    const uid = await start(a);
    let res = await postAssertion(uid, await hubAssertion("other", uid), b);
    expect(res.status).toBe(303);

    // B follows to /complete: it has the completion cookie but not A's
    // interaction cookie → error page, nothing finished.
    res = await get(new URL(res.headers.get("location")!, issuer).href, b);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("browser_mismatch");

    // A has the interaction (and resume) cookies but never the completion
    // cookie: neither /complete nor resuming yields a code.
    res = await get(`${issuer}/interaction/${uid}/complete`, a);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("browser_mismatch");
    res = await get(`${issuer}/auth/${uid}`, a);
    expect(res.headers.get("location") ?? "").not.toContain("code=");
    expect(res.headers.get("location") ?? "").not.toContain(`${rpBase}/cb`);
  });

  it("refuses A completing with B's parked login, even before B tries (login CSRF direction)", async () => {
    accounts.rows.set("attacker", {
      sub: "attacker",
      email: null,
      name: null,
      picture: null,
      roles: [],
      isActive: true,
    });
    const a = new Jar();
    const uid = await start(a);
    // The assertion is posted from elsewhere (B keeps the completion cookie).
    expect((await postAssertion(uid, await hubAssertion("attacker", uid), new Jar())).status).toBe(303);
    const res = await get(`${issuer}/interaction/${uid}/complete`, a);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("browser_mismatch");
  });

  it("a completion cookie works once only", async () => {
    accounts.rows.set("u-5", { sub: "u-5", email: null, name: null, picture: null, roles: [], isActive: true });
    const { callback, jar, uid } = await signIn("u-5", {
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect(callback!.searchParams.get("code")).toBeTruthy();
    const again = await get(`${issuer}/interaction/${uid}/complete`, jar);
    expect(again.status).toBe(400);
  });

  it("rotates refresh tokens (offline_access): the old one is rejected after use", async () => {
    accounts.rows.set("u-3", { sub: "u-3", email: null, name: null, picture: null, roles: [], isActive: true });
    const { verifier, challenge } = pkce();
    const { callback } = await signIn("u-3", {
      scope: "openid offline_access",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const t = await token({
      grant_type: "authorization_code",
      code: callback!.searchParams.get("code")!,
      redirect_uri: `${rpBase}/cb`,
      code_verifier: verifier,
    });
    const first = t.json.refresh_token as string;
    expect(first).toBeTruthy();

    const r1 = await token({ grant_type: "refresh_token", refresh_token: first });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).toBeTruthy();
    expect(r1.json.refresh_token).not.toBe(first);

    const reuse = await token({ grant_type: "refresh_token", refresh_token: first });
    expect(reuse.json.error).toBe("invalid_grant");
  });

  it("RP-initiated logout POSTs a back-channel logout token to the client", async () => {
    accounts.rows.set("u-4", { sub: "u-4", email: null, name: null, picture: null, roles: [], isActive: true });
    const { verifier, challenge } = pkce();
    const { callback, jar } = await signIn("u-4", { code_challenge: challenge, code_challenge_method: "S256" });
    const t = await token({
      grant_type: "authorization_code",
      code: callback!.searchParams.get("code")!,
      redirect_uri: `${rpBase}/cb`,
      code_verifier: verifier,
    });
    const sid = decodeJwt(t.json.id_token as string).sid;

    const end = new URL(`${issuer}/session/end`);
    end.searchParams.set("id_token_hint", t.json.id_token as string);
    end.searchParams.set("post_logout_redirect_uri", `${rpBase}/bye`);
    let res = await get(end.href, jar);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign out?");
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)![1]!;

    backchannel.length = 0;
    res = await fetch(`${issuer}/session/end/confirm`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: new URLSearchParams({ xsrf, logout: "yes" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${rpBase}/bye`);

    await expect.poll(() => backchannel.length, { timeout: 5000 }).toBe(1);
    const { payload } = await jwtVerify(backchannel[0]!, createRemoteJWKSet(new URL(`${issuer}/jwks`)), {
      issuer,
      audience: CLIENT_ID,
    });
    expect(payload).toMatchObject({
      sub: "u-4",
      sid,
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    });
  });

  it("stores everything under the oidc: prefix with a TTL", async () => {
    const keys = await redis.keys("*");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("oidc:"))).toBe(true);
    for (const k of keys) expect(await redis.ttl(k)).toBeGreaterThan(0);
  });
});
