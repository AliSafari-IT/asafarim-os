/**
 * "Continue with Google": an OpenID Connect sign-in at Google, with the authorization code flow,
 * PKCE (S256), a `state` bound to this browser's login flow and a `nonce` bound to the ID token.
 *
 * Google only proves who the person is (authentication). It grants nothing: the principal it
 * resolves to still needs an active connection, given by an admin, like any other sign-in.
 *
 * No library: the code is exchanged at Google's token endpoint over TLS with the client secret,
 * and the ID token is verified with jose against Google's published keys (issuer, audience,
 * expiry, signature, nonce).
 */
import { createHash, randomBytes } from "node:crypto";
import { type JWTVerifyGetKey, createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
/** Google issues ID tokens with either spelling. */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/** Who Google says signed in. */
export interface GoogleIdentity {
  /** Google's stable account id (`sub`): the identity's identifier. Never reused by Google. */
  subject: string;
  /** Lower-case email, only when Google says it is verified; else null. */
  email: string | null;
  /**
   * Google is the authority for this address: an @gmail.com address, or a Google Workspace one (`hd`
   * matches the address's domain). Only then may the sign-in join an existing email identity.
   */
  authoritative: boolean;
}

export class GoogleError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`google sign-in failed: ${reason}`);
    this.name = "GoogleError";
    this.reason = reason;
  }
}

export interface GoogleStart {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface GoogleFinish {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  nonce: string;
}

/** The two steps the sign-in routes need; tests use a fake. */
export interface GoogleSignIn {
  authorizeUrl(start: GoogleStart): string;
  /** Exchanges the code and verifies the ID token; throws GoogleError. */
  finish(finish: GoogleFinish): Promise<GoogleIdentity>;
}

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** What Google's ID token claims say about the person (exported for tests). */
export function identityFromClaims(claims: Record<string, unknown>): GoogleIdentity {
  const subject = claims.sub;
  if (typeof subject !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(subject)) {
    throw new GoogleError("invalid_subject");
  }
  const raw = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const email = verified && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) && raw.length <= 254 ? raw : null;
  const domain = email ? email.slice(email.lastIndexOf("@") + 1) : "";
  const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
  const authoritative = Boolean(email) && (CONSUMER_DOMAINS.has(domain) || (hd !== "" && hd === domain));
  return { subject, email, authoritative };
}

export class GoogleOidc implements GoogleSignIn {
  private readonly config: GoogleConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly keys: JWTVerifyGetKey;

  constructor(config: GoogleConfig, opts: { fetch?: typeof fetch; keys?: JWTVerifyGetKey } = {}) {
    this.config = config;
    this.fetchImpl = opts.fetch ?? fetch;
    this.keys = opts.keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }

  authorizeUrl(s: GoogleStart): string {
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: s.redirectUri,
      response_type: "code",
      scope: "openid email",
      state: s.state,
      nonce: s.nonce,
      code_challenge: s.codeChallenge,
      code_challenge_method: "S256",
      // Always let the person pick the account: a shared computer may be signed in to someone else's.
      prompt: "select_account",
    }).toString();
    return url.href;
  }

  async finish(f: GoogleFinish): Promise<GoogleIdentity> {
    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: f.code,
          redirect_uri: f.redirectUri,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code_verifier: f.codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GoogleError("token_unreachable");
    }
    if (!response.ok) throw new GoogleError(`token_${response.status}`);
    let idToken: unknown;
    try {
      idToken = ((await response.json()) as { id_token?: unknown }).id_token;
    } catch {
      throw new GoogleError("token_response");
    }
    if (typeof idToken !== "string") throw new GoogleError("no_id_token");

    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(idToken, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: this.config.clientId,
        algorithms: ["RS256"],
        clockTolerance: 30,
      }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new GoogleError("id_token_expired");
      if (err instanceof joseErrors.JWTClaimValidationFailed) throw new GoogleError(`id_token_${err.claim}`);
      throw new GoogleError("id_token_invalid");
    }
    if (claims.nonce !== f.nonce) throw new GoogleError("id_token_nonce");
    return identityFromClaims(claims);
  }
}
