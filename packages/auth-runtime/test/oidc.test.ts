/**
 * UNIT tests of the OIDC client against a stub provider with real signatures (see stub-provider.ts). They cover the
 * rejection paths that a real provider never emits. The real-provider positive paths live in
 * core/identity/test/auth-runtime.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  IdentityUnavailableError,
  InvalidConfigError,
  InvalidStateError,
  LogoutTokenInvalidError,
  ProviderRejectedError,
  TokenValidationError,
} from "../src/index.ts";
import { BACKCHANNEL_LOGOUT_EVENT, createOidcClient } from "../src/oidc.ts";
import { CLIENT_ID, ISSUER, ORIGIN } from "./helpers.ts";
import { stubProvider } from "./stub-provider.ts";

const REDIRECT = `${ORIGIN}/auth/callback`;

async function setup(over: Partial<Parameters<typeof createOidcClient>[0]> = {}) {
  const p = await stubProvider();
  const client = createOidcClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    fetch: p.fetch,
    ...over,
  });
  return { p, client };
}

const callback = (state: string, code = "the-code") => {
  const u = new URL(REDIRECT);
  u.searchParams.set("code", code);
  u.searchParams.set("state", state);
  return u;
};

describe("unit: configuration", () => {
  const base = { issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT };
  it.each([
    ["http issuer without the dev switch", { issuer: "http://id.example" }],
    [
      "http issuer on a non-loopback host even with the switch",
      { issuer: "http://id.example", allowInsecureHttp: true },
    ],
    ["credentials in the issuer", { issuer: "https://u:p@id.example" }],
    ["redirect with a query", { redirectUri: `${REDIRECT}?x=1` }],
    ["redirect with a fragment", { redirectUri: `${REDIRECT}#x` }],
    ["no client id", { clientId: "" }],
    ["scope without openid", { scope: ["email"] }],
    ["HS256 logout algorithms", { logoutTokenAlgorithms: ["HS256"] }],
    ["none logout algorithm", { logoutTokenAlgorithms: ["none"] }],
    ["not a URL", { issuer: "nope" }],
  ])("refuses %s", (_l, over) => {
    expect(() => createOidcClient({ ...base, ...over })).toThrow(InvalidConfigError);
  });
  it("allows http on loopback only with the explicit switch", () => {
    expect(() =>
      createOidcClient({
        ...base,
        issuer: "http://localhost:4010",
        redirectUri: "http://localhost:3000/cb",
        allowInsecureHttp: true,
      }),
    ).not.toThrow();
  });
});

describe("unit: authorization request", () => {
  it("is code + PKCE S256 + state + nonce with the exact redirect URI, and never carries a secret", async () => {
    const { client } = await setup({ clientSecret: "s3cr3t-s3cr3t-s3cr3t" });
    const pkce = await client.newPkce();
    const u = await client.authorizationUrl({
      state: "st",
      nonce: "no",
      codeChallenge: pkce.challenge,
      maxAge: 300,
      prompt: ["login"],
      uiLocales: "nl",
      extra: { screen_hint: "register" },
    });
    const q = u.searchParams;
    expect(u.origin + u.pathname).toBe(`${ISSUER}/auth`);
    expect(Object.fromEntries(q)).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      state: "st",
      nonce: "no",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      max_age: "300",
      ui_locales: "nl",
      screen_hint: "register",
    });
    expect(q.get("scope")).toBe("openid email profile offline_access");
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.challenge).not.toBe(pkce.verifier);
    expect(u.href).not.toContain("s3cr3t");
  });
  it("adds consent for a refresh token, but never when the app asked for prompt=none", async () => {
    const { client } = await setup();
    const a = await client.authorizationUrl({
      state: "a",
      nonce: "a",
      codeChallenge: "c".repeat(43),
      prompt: ["login"],
    });
    expect(a.searchParams.get("prompt")?.split(" ").sort()).toEqual(["consent", "login"]);
    const b = await client.authorizationUrl({
      state: "a",
      nonce: "a",
      codeChallenge: "c".repeat(43),
      prompt: ["none"],
    });
    expect(b.searchParams.get("prompt")).toBe("none");
    const c = await setup({ scope: ["openid", "email"] }).then((s) =>
      s.client.authorizationUrl({ state: "a", nonce: "a", codeChallenge: "c".repeat(43) }),
    );
    expect(c.searchParams.has("prompt")).toBe(false);
  });
  it("a provider outage is IdentityUnavailableError", async () => {
    const { client, p } = await setup();
    p.state.down = true;
    await expect(
      client.authorizationUrl({ state: "a", nonce: "a", codeChallenge: "c".repeat(43) }),
    ).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});

describe("unit: code exchange and ID-token validation", () => {
  async function exchangeWith(
    idClaims: Record<string, unknown> | undefined,
    o: {
      key?: "good" | "evil" | "hmac" | "none";
      checks?: Partial<{ nonce: string; maxAge: number }>;
      tokenBody?: Record<string, unknown>;
      status?: number;
    } = {},
  ) {
    const { client, p } = await setup();
    const now = p.now();
    const idToken = idClaims
      ? await p.sign(
          {
            sub: "sub-1",
            exp: now + 300,
            nonce: "the-nonce",
            auth_time: now - 5,
            sid: "sid-1",
            amr: ["otp"],
            acr: "1",
            email: "person@example.test",
            ...idClaims,
          },
          { key: o.key },
        )
      : undefined;
    p.state.token = () => ({
      status: o.status ?? 200,
      body: {
        access_token: "access-token-abcdef",
        token_type: "Bearer",
        expires_in: 600,
        refresh_token: "refresh-token-abcdef",
        ...(idToken ? { id_token: idToken } : {}),
        ...o.tokenBody,
      },
    });
    return client.exchange(callback("the-state"), {
      state: "the-state",
      nonce: o.checks?.nonce ?? "the-nonce",
      verifier: "v".repeat(43),
      ...(o.checks?.maxAge !== undefined ? { maxAge: o.checks.maxAge } : {}),
    });
  }

  it("returns validated claims: identity key, auth_time, sid, amr and acr come from the verified ID token", async () => {
    const id = await exchangeWith({});
    expect(id.identityKey).toEqual({ iss: ISSUER, sub: "sub-1" });
    expect(id).toMatchObject({
      sid: "sid-1",
      amr: ["otp"],
      acr: "1",
      emailHint: "person@example.test",
      accessToken: "access-token-abcdef",
      refreshToken: "refresh-token-abcdef",
      expiresIn: 600,
    });
    expect(typeof id.authTime).toBe("number");
  });

  it("refuses a wrong issuer, audience, nonce, expiry, signature and algorithm with a typed reason", async () => {
    const cases: [string, Promise<unknown>, string][] = [
      ["issuer", exchangeWith({ iss: "https://evil.example" }), "issuer"],
      ["audience", exchangeWith({ aud: "someone-else" }), "audience"],
      ["nonce", exchangeWith({ nonce: "other" }), "nonce"],
      ["expired", exchangeWith({ exp: Math.floor(Date.now() / 1000) - 3600 }), "expired"],
      ["signed by another key", exchangeWith({}, { key: "evil" }), "signature"],
    ];
    for (const [label, p, reason] of cases) {
      const err = await p.catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(TokenValidationError);
      expect((err as TokenValidationError).reason, label).toBe(reason);
    }
    for (const key of ["hmac", "none"] as const) {
      await expect(exchangeWith({}, { key }), key).rejects.toBeInstanceOf(TokenValidationError);
    }
  });

  it("refuses a missing ID token, a missing auth_time and a missing subject", async () => {
    await expect(exchangeWith(undefined)).rejects.toBeInstanceOf(TokenValidationError);
    await expect(exchangeWith({ auth_time: undefined })).rejects.toBeInstanceOf(TokenValidationError);
    await expect(exchangeWith({ sub: undefined })).rejects.toBeInstanceOf(TokenValidationError);
  });

  it("refuses an auth_time older than max_age", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(exchangeWith({ auth_time: now - 1000 }, { checks: { maxAge: 300 } })).rejects.toBeInstanceOf(
      TokenValidationError,
    );
    await expect(exchangeWith({ auth_time: now - 100 }, { checks: { maxAge: 300 } })).resolves.toBeTruthy();
  });

  it("refuses a response without an access token or a usable lifetime", async () => {
    await expect(exchangeWith({}, { tokenBody: { access_token: "" } })).rejects.toBeInstanceOf(Error);
    await expect(exchangeWith({}, { tokenBody: { expires_in: 0 } })).rejects.toBeInstanceOf(Error);
  });

  it("checks state before any network call, and the callback path", async () => {
    const { client, p } = await setup();
    await expect(
      client.exchange(callback("other"), { state: "mine", nonce: "n", verifier: "v".repeat(43) }),
    ).rejects.toBeInstanceOf(InvalidStateError);
    const dup = callback("mine");
    dup.searchParams.append("state", "mine");
    await expect(client.exchange(dup, { state: "mine", nonce: "n", verifier: "v".repeat(43) })).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    const wrongPath = new URL(`${ORIGIN}/elsewhere?code=x&state=mine`);
    await expect(
      client.exchange(wrongPath, { state: "mine", nonce: "n", verifier: "v".repeat(43) }),
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect(p.state.requests.filter((r) => r.includes("/token"))).toEqual([]);
  });

  it("maps an OAuth error response to AuthorizationError with a closed code, and 5xx to unavailable", async () => {
    const { client } = await setup();
    const u = new URL(REDIRECT);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "secret detail the person must not see");
    u.searchParams.set("state", "mine");
    const err = await client
      .exchange(u, { state: "mine", nonce: "n", verifier: "v".repeat(43) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).reason).toBe("access_denied");
    expect(JSON.stringify(err) + (err as Error).message).not.toContain("secret detail");
    await expect(exchangeWith({}, { status: 503, tokenBody: { error: "server_error" } })).rejects.toBeInstanceOf(
      IdentityUnavailableError,
    );
    await expect(exchangeWith({}, { status: 400, tokenBody: { error: "invalid_grant" } })).rejects.toBeInstanceOf(
      ProviderRejectedError,
    );
  });
});

describe("unit: refresh and userinfo", () => {
  it("refresh returns the rotated tokens; invalid_grant is a rejection; 5xx and network errors are an outage", async () => {
    const { client, p } = await setup();
    p.state.token = () => ({
      status: 200,
      body: {
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 600,
        refresh_token: "new-refresh-token",
      },
    });
    expect(await client.refresh("old", "sub-1")).toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 600,
    });
    p.state.token = () => ({ status: 400, body: { error: "invalid_grant" } });
    await expect(client.refresh("old", "sub-1")).rejects.toBeInstanceOf(ProviderRejectedError);
    p.state.token = () => ({ status: 502, body: {} });
    await expect(client.refresh("old", "sub-1")).rejects.toBeInstanceOf(IdentityUnavailableError);
    p.state.down = true;
    await expect(client.refresh("old", "sub-1")).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it("refresh refuses a different subject in a returned ID token", async () => {
    const { client, p } = await setup();
    const now = p.now();
    p.state.token = () => ({
      status: 200,
      body: { access_token: "a-new-access-token", token_type: "Bearer", expires_in: 60 },
    });
    expect((await client.refresh("old", "sub-1")).accessToken).toBe("a-new-access-token");
    const idToken = await p.sign({ sub: "someone-else", exp: now + 300 });
    p.state.token = () => ({
      status: 200,
      body: { access_token: "a-new-access-token", token_type: "Bearer", expires_in: 60, id_token: idToken },
    });
    await expect(client.refresh("old", "sub-1")).rejects.toBeInstanceOf(Error);
  });

  it("userinfo: same subject passes; another subject, 401 and 503 are distinguished", async () => {
    const { client, p } = await setup();
    p.state.userinfo = () => ({ status: 200, body: { sub: "sub-1", email: "person@example.test" } });
    expect(await client.userinfo("at", "sub-1")).toEqual({ sub: "sub-1", email: "person@example.test" });
    p.state.userinfo = () => ({ status: 200, body: { sub: "sub-2" } });
    await expect(client.userinfo("at", "sub-1")).rejects.toMatchObject({
      code: "provider_rejected",
      reason: "subject_mismatch",
    });
    p.state.userinfo = () => ({
      status: 401,
      body: { error: "invalid_token" },
      headers: { "www-authenticate": 'Bearer error="invalid_token"' },
    });
    await expect(client.userinfo("at", "sub-1")).rejects.toBeInstanceOf(ProviderRejectedError);
    p.state.userinfo = () => ({ status: 503, body: {} });
    await expect(client.userinfo("at", "sub-1")).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});

describe("unit: RP-initiated logout URL", () => {
  it("uses the discovered end-session endpoint with client_id and the post-logout URI", async () => {
    const { client } = await setup({ postLogoutRedirectUri: `${ORIGIN}/` });
    const u = new URL(await client.endSessionUrl());
    expect(u.origin + u.pathname).toBe(`${ISSUER}/session/end`);
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("post_logout_redirect_uri")).toBe(`${ORIGIN}/`);
    expect(
      new URL(await client.endSessionUrl({ postLogoutRedirectUri: null })).searchParams.has("post_logout_redirect_uri"),
    ).toBe(false);
  });
  it("falls back to <issuer>/session/end when discovery is down, and never throws", async () => {
    const { client, p } = await setup();
    p.state.down = true;
    const u = new URL(await client.endSessionUrl({ postLogoutRedirectUri: `${ORIGIN}/` }));
    expect(u.origin + u.pathname).toBe(`${ISSUER}/session/end`);
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
  });
});

describe("unit: signed back-channel logout token validation (crafted tokens)", () => {
  const event = { [BACKCHANNEL_LOGOUT_EVENT]: {} };
  async function validate(
    claims: Record<string, unknown>,
    o: Parameters<Awaited<ReturnType<typeof stubProvider>>["sign"]>[1] = {},
    over: Partial<Parameters<typeof createOidcClient>[0]> = {},
  ) {
    const { client, p } = await setup(over);
    const now = p.now();
    const token = await p.sign({ jti: "jti-1", sid: "sid-1", events: event, ...claims }, { typ: "logout+jwt", ...o });
    return { result: client.validateLogoutToken(token), p, now };
  }
  const accepted = async (claims: Record<string, unknown> = {}, o = {}) => (await validate(claims, o)).result;

  it("accepts a well-formed token and returns only what the runtime needs", async () => {
    expect(await accepted()).toMatchObject({ jti: "jti-1", sid: "sid-1" });
    expect(await accepted({ sid: undefined, sub: "sub-1" })).toMatchObject({ sub: "sub-1" });
    const both = await accepted({ sub: "sub-1" });
    expect(both).toMatchObject({ sid: "sid-1", sub: "sub-1" });
  });

  it.each([
    ["wrong issuer", { iss: "https://evil.example" }, {}],
    ["wrong audience", { aud: "someone-else" }, {}],
    ["has a nonce (forbidden)", { nonce: "n" }, {}],
    ["no events", { events: undefined }, {}],
    ["wrong event member", { events: { "http://schemas.openid.net/event/other": {} } }, {}],
    ["event member is not an object", { events: { [BACKCHANNEL_LOGOUT_EVENT]: "yes" } }, {}],
    ["events is an array", { events: [BACKCHANNEL_LOGOUT_EVENT] }, {}],
    ["no jti", { jti: undefined }, {}],
    ["jti is a number", { jti: 5 }, {}],
    ["jti too long", { jti: "j".repeat(401) }, {}],
    ["neither sid nor sub", { sid: undefined }, {}],
    ["sid is not a string", { sid: 7 }, {}],
    ["no iat", { iat: undefined }, {}],
    ["older than two minutes", { iat: Math.floor(Date.now() / 1000) - 300 }, {}],
    ["from the future", { iat: Math.floor(Date.now() / 1000) + 600 }, {}],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 10 }, {}],
    ["signed by another key", {}, { key: "evil" as const }],
    ["unknown key id", {}, { kid: "nope" }],
    ["HS256 with a shared secret", {}, { key: "hmac" as const }],
    ["alg none", {}, { key: "none" as const }],
  ])("refuses a token that %s", async (_label, claims, o) => {
    await expect(accepted(claims, o)).rejects.toBeInstanceOf(LogoutTokenInvalidError);
  });

  it("refuses garbage, an empty string and an oversize token without calling the provider's key endpoint", async () => {
    const { client, p } = await setup();
    for (const t of ["", "not.a.jwt", "x".repeat(20_000), 5 as unknown as string])
      await expect(client.validateLogoutToken(t)).rejects.toBeInstanceOf(LogoutTokenInvalidError);
    expect(p.state.requests.filter((r) => r.includes("/jwks"))).toEqual([]);
  });

  it("an unreachable key set is an outage the sender may retry, not an 'invalid token'", async () => {
    const { client, p } = await setup();
    const token = await p.sign({ jti: "j", sid: "s", events: event }, { typ: "logout+jwt" });
    p.state.jwksDown = true;
    await expect(client.validateLogoutToken(token)).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});
