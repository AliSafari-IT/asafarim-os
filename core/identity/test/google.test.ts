/**
 * "Continue with Google" against a stand-in Google: a local RS256 key and a fake token endpoint.
 */
import { type CryptoKey, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { GOOGLE_TOKEN_URL, GoogleError, GoogleOidc, identityFromClaims, pkcePair } from "../src/google.ts";
import { createHash } from "node:crypto";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const REDIRECT = "https://id.example.test/login/google/callback";

describe("Google sign-in", () => {
  let privateKey: CryptoKey;
  let keys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
  });

  const idToken = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: number } = {}) =>
    new SignJWT({ email: "ali@gmail.com", email_verified: true, nonce: "n1", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? "https://accounts.google.com")
      .setAudience(opts.aud ?? CLIENT_ID)
      .setSubject("1234567890")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);

  /** A token endpoint that answers with `token`, recording what it was sent. */
  function google(token: () => Promise<string>, status = 200) {
    const sent: URLSearchParams[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      expect(url).toBe(GOOGLE_TOKEN_URL);
      sent.push(new URLSearchParams(init.body as string));
      return new Response(JSON.stringify({ id_token: await token(), access_token: "x" }), { status });
    }) as unknown as typeof fetch;
    return {
      sent,
      oidc: new GoogleOidc({ clientId: CLIENT_ID, clientSecret: "s".repeat(24) }, { fetch: fetchStub, keys }),
    };
  }

  const finish = { code: "c0de", redirectUri: REDIRECT, codeVerifier: "v".repeat(43), nonce: "n1" };

  it("sends the person to Google with PKCE, a state, a nonce and the account chooser", () => {
    const { oidc } = google(() => idToken({}));
    const url = new URL(oidc.authorizeUrl({ redirectUri: REDIRECT, state: "st", nonce: "n1", codeChallenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "openid email",
      state: "st",
      nonce: "n1",
      code_challenge: "ch",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });

  it("a PKCE pair: the challenge is the verifier's SHA-256", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("exchanges the code with the verifier and secret, and returns who signed in", async () => {
    const { oidc, sent } = google(() => idToken({}));
    await expect(oidc.finish(finish)).resolves.toEqual({
      subject: "1234567890",
      email: "ali@gmail.com",
      authoritative: true,
    });
    expect(Object.fromEntries(sent[0]!)).toMatchObject({
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: "v".repeat(43),
    });
  });

  it("refuses a wrong nonce, audience, issuer, an expired token and a failed exchange", async () => {
    const reason = async (g: ReturnType<typeof google>) => {
      try {
        await g.oidc.finish(finish);
        return "accepted";
      } catch (err) {
        return (err as GoogleError).reason;
      }
    };
    expect(await reason(google(() => idToken({ nonce: "other" })))).toBe("id_token_nonce");
    expect(await reason(google(() => idToken({}, { aud: "someone-else" })))).toBe("id_token_aud");
    expect(await reason(google(() => idToken({}, { iss: "https://evil.example" })))).toBe("id_token_iss");
    const past = Math.floor(Date.now() / 1000) - 600;
    expect(await reason(google(() => idToken({}, { exp: past })))).toBe("id_token_expired");
    expect(await reason(google(() => idToken({}), 400))).toBe("token_400");
    expect(await reason(google(async () => "not.a.jwt"))).toBe("id_token_invalid");
  });

  it("Google is the authority only for Gmail and matching Workspace addresses, and only when verified", () => {
    expect(identityFromClaims({ sub: "1", email: "Ali@Gmail.com", email_verified: true })).toEqual({
      subject: "1",
      email: "ali@gmail.com",
      authoritative: true,
    });
    expect(identityFromClaims({ sub: "1", email: "a@co.be", email_verified: true, hd: "co.be" }).authoritative).toBe(
      true,
    );
    // A non-Google address on a Google account: shown, but never used to join an existing account.
    expect(identityFromClaims({ sub: "1", email: "a@co.be", email_verified: true })).toEqual({
      subject: "1",
      email: "a@co.be",
      authoritative: false,
    });
    expect(identityFromClaims({ sub: "1", email: "a@co.be", email_verified: true, hd: "other.be" }).authoritative).toBe(
      false,
    );
    expect(identityFromClaims({ sub: "1", email: "ali@gmail.com", email_verified: false })).toEqual({
      subject: "1",
      email: null,
      authoritative: false,
    });
    expect(() => identityFromClaims({ sub: "../x" })).toThrow(GoogleError);
  });
});
