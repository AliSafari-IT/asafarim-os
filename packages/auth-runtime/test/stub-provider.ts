import * as jose from "jose";
import { CLIENT_ID, ISSUER, ORIGIN } from "./helpers.ts";

/**
 * A tiny OIDC provider behind an injected `fetch`: discovery, JWKS, token and userinfo endpoints, with real ES256
 * signatures, so tests can craft bad tokens (wrong issuer, audience, nonce, key, algorithm, age). UNIT-TEST ONLY:
 * the real provider is exercised in core/identity/test/auth-runtime.integration.test.ts.
 */
export async function stubProvider() {
  const good = await jose.generateKeyPair("ES256");
  const evil = await jose.generateKeyPair("ES256");
  const jwk = { ...(await jose.exportJWK(good.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const hmac = new TextEncoder().encode("h".repeat(64));
  const state = {
    down: false,
    jwksDown: false,
    requests: [] as string[],
    token: undefined as undefined | (() => { status: number; body: unknown }),
    userinfo: undefined as undefined | (() => { status: number; body: unknown; headers?: Record<string, string> }),
    discoveryHits: 0,
    endSession: true as boolean,
  };
  const now = () => Math.floor(Date.now() / 1000);

  async function sign(
    claims: Record<string, unknown>,
    o: { key?: "good" | "evil" | "hmac" | "none"; typ?: string; kid?: string } = {},
  ): Promise<string> {
    const base = { iss: ISSUER, aud: CLIENT_ID, iat: now(), ...claims };
    if (o.key === "none") {
      const b = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      return `${b({ alg: "none", typ: o.typ })}.${b(base)}.`;
    }
    const jwt = new jose.SignJWT(base);
    if (o.key === "hmac") return jwt.setProtectedHeader({ alg: "HS256", ...(o.typ ? { typ: o.typ } : {}) }).sign(hmac);
    return jwt
      .setProtectedHeader({ alg: "ES256", kid: o.kid ?? "k1", ...(o.typ ? { typ: o.typ } : {}) })
      .sign(o.key === "evil" ? evil.privateKey : good.privateKey);
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    state.requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (state.down) throw new TypeError("fetch failed");
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        state.discoveryHits++;
        return json(200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          userinfo_endpoint: `${ISSUER}/me`,
          jwks_uri: `${ISSUER}/jwks`,
          ...(state.endSession ? { end_session_endpoint: `${ISSUER}/session/end` } : {}),
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      case "/jwks":
        if (state.jwksDown) throw new TypeError("fetch failed");
        return json(200, { keys: [jwk] });
      case "/token": {
        const r = state.token?.() ?? { status: 500, body: { error: "server_error" } };
        return json(r.status, r.body);
      }
      case "/me": {
        const r = state.userinfo?.() ?? { status: 500, body: {} };
        return json(r.status, r.body, r.headers);
      }
      default:
        return json(404, {});
    }
  }) as typeof fetch;

  return { fetch: fetchStub, sign, state, now, redirect: `${ORIGIN}/auth/callback` };
}
