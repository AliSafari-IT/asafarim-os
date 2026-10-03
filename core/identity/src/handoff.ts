/**
 * The signed hand-off between the identity service and Hub (ADR 0002,
 * Addendum A2). Two short-lived Ed25519 JWS, one per direction, each with its
 * own key pair; unrelated to the OIDC JWKS.
 *
 *   ticket     identity → Hub   iss=id  aud=hub  uid, nonce   exp ≤ 120 s
 *   assertion  Hub → identity   iss=hub aud=id   sub, uid, jti exp ≤ 60 s, jti single-use
 */
import { randomBytes } from "node:crypto";
import { SignJWT, errors as joseErrors, jwtVerify, type CryptoKey, type KeyObject } from "jose";

export const TICKET_ISSUER = "id";
export const TICKET_AUDIENCE = "hub";
export const TICKET_TTL_SECONDS = 120;

export const ASSERTION_ISSUER = "hub";
export const ASSERTION_AUDIENCE = "id";
export const ASSERTION_MAX_TTL_SECONDS = 60;

type Key = CryptoKey | KeyObject;

/** Why a hand-off token was refused. Logged as a code, never with the token. */
export type HandoffFailure = "bad_signature" | "wrong_audience" | "expired" | "replayed" | "wrong_uid" | "invalid";

export class HandoffError extends Error {
  readonly code: HandoffFailure;
  constructor(code: HandoffFailure, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "HandoffError";
    this.code = code;
  }
}

/** Remembers assertion `jti`s so each is accepted once (Redis in production). */
export interface ReplayGuard {
  /** True the first time `jti` is seen within `ttlSeconds`, false after that. */
  claimOnce(jti: string, ttlSeconds: number): Promise<boolean>;
}

/** The identity → Hub ticket for interaction `uid`. */
export async function issueTicket(uid: string, privateKey: Key, now = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ uid, nonce: randomBytes(16).toString("base64url") })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(TICKET_ISSUER)
    .setAudience(TICKET_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + TICKET_TTL_SECONDS)
    .sign(privateKey);
}

/** Verify a Hub ticket (used by tests and as the reference for Hub's verifier). */
export async function verifyTicket(ticket: string, publicKey: Key, now = new Date()) {
  const { payload } = await verify(ticket, publicKey, {
    issuer: TICKET_ISSUER,
    audience: TICKET_AUDIENCE,
    maxTtl: TICKET_TTL_SECONDS,
    required: ["uid", "nonce", "iat", "exp"],
    now,
  });
  return { uid: String(payload.uid), nonce: String(payload.nonce) };
}

export interface VerifyAssertionOptions {
  hubPublicKey: Key;
  /** The interaction the assertion is posted to; it must match the `uid` claim. */
  uid: string;
  replay: ReplayGuard;
  now?: Date;
}

/**
 * Verify Hub's assertion for interaction `uid` and consume its `jti`.
 * Signature, issuer, audience, lifetime and `uid` are all checked before the
 * `jti` is consumed, so a forged or misdirected token can't burn a real one.
 */
export async function verifyAssertion(assertion: string, opts: VerifyAssertionOptions): Promise<{ sub: string }> {
  const now = opts.now ?? new Date();
  const { payload } = await verify(assertion, opts.hubPublicKey, {
    issuer: ASSERTION_ISSUER,
    audience: ASSERTION_AUDIENCE,
    maxTtl: ASSERTION_MAX_TTL_SECONDS,
    required: ["sub", "uid", "jti", "iat", "exp"],
    now,
  });
  if (payload.uid !== opts.uid) throw new HandoffError("wrong_uid");
  if (typeof payload.sub !== "string" || !payload.sub) throw new HandoffError("invalid", "sub");
  if (typeof payload.jti !== "string" || !payload.jti) throw new HandoffError("invalid", "jti");

  const remaining = Math.max(1, (payload.exp as number) - Math.floor(now.getTime() / 1000));
  if (!(await opts.replay.claimOnce(payload.jti, remaining))) throw new HandoffError("replayed");
  return { sub: payload.sub };
}

interface VerifyOptions {
  issuer: string;
  audience: string;
  maxTtl: number;
  required: string[];
  now: Date;
}

async function verify(token: string, key: Key, o: VerifyOptions) {
  let result;
  try {
    result = await jwtVerify(token, key, {
      algorithms: ["EdDSA"],
      issuer: o.issuer,
      audience: o.audience,
      requiredClaims: o.required,
      currentDate: o.now,
    });
  } catch (err) {
    throw toHandoffError(err);
  }
  const { iat, exp } = result.payload as { iat: number; exp: number };
  // A token minted with a longer lifetime than the contract allows is refused,
  // even while it is still inside its own exp.
  if (exp - iat > o.maxTtl) throw new HandoffError("invalid", "lifetime too long");
  return result;
}

function toHandoffError(err: unknown): HandoffError {
  if (err instanceof joseErrors.JWTExpired) return new HandoffError("expired");
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return new HandoffError("bad_signature");
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === "aud") return new HandoffError("wrong_audience");
    return new HandoffError("invalid", err.claim);
  }
  return new HandoffError("invalid");
}
