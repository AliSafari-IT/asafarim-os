/**
 * The short-lived access token (P3.3a, ADR 0001 §4/§7): a compact EdDSA (Ed25519)
 * JWT that core-api issues for ONE subject in ONE app and that is verified
 * LOCALLY (the gateway hook in core-api, and the app SDK), with no database
 * read, no signed call and no nonce write per request.
 *
 *   header   { alg: "EdDSA", typ: "JWT", kid }
 *   payload  { iss: "asafarim-core-api", sub, aud: <app id>, roles: [...], perms: [...], iat, exp }
 *
 * Trade-off (also in core/core-api/README.md): the token carries the subject's
 * permissions as of issue time, so a revoked grant keeps working until the
 * token expires: at most the token's lifetime (`ACCESS_TOKEN_TTL_SECONDS`, 60 s
 * by default) at the gateway, plus `ACCESS_TOKEN_SKEW_SECONDS` in an app on
 * another clock. The app's lifecycle state is NOT in the token: the gateway
 * reads it live.
 */
import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export const ACCESS_TOKEN_ISSUER = "asafarim-core-api";
export const ACCESS_TOKEN_TTL_SECONDS = 60;
/** Host-only: no Domain, so one app's token never reaches another app's host. */
export const ACCESS_COOKIE_NAME = "__Host-asafarim.access";
/** Served by every app (via @asafarim/app-sdk): re-issues the token for a signed-in person, then returns to `?next=`. */
export const ACCESS_SESSION_PATH = "/api/asafarim/session";
/** Allowed clock difference between the signer and a verifier, in seconds. */
export const ACCESS_TOKEN_SKEW_SECONDS = 5;
const MAX_TOKEN_LENGTH = 8192;

export interface AccessClaims {
  iss: typeof ACCESS_TOKEN_ISSUER;
  sub: string;
  aud: string;
  roles: string[];
  perms: string[];
  iat: number;
  exp: number;
}

export type TokenProblem = "malformed" | "unknown_key" | "bad_signature" | "expired" | "wrong_audience";

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: TokenProblem };

/** A signing key: the Ed25519 private key as a JWK (what .dev/core-api.env holds) and its id. */
export interface SigningKey {
  kid: string;
  privateJwk: JsonWebKey;
}

/** A published verification key (one entry of core-api's JWKS). */
export interface VerificationKey {
  kid: string;
  publicJwk: JsonWebKey;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export interface SignAccessTokenOptions {
  key: SigningKey;
  subject: string;
  audience: string;
  roles: string[];
  permissions: string[];
  ttlSeconds?: number;
  now?: Date;
}

export function signAccessToken(opts: SignAccessTokenOptions): { token: string; claims: AccessClaims } {
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const claims: AccessClaims = {
    iss: ACCESS_TOKEN_ISSUER,
    sub: opts.subject,
    aud: opts.audience,
    roles: [...opts.roles].sort(),
    perms: [...opts.permissions].sort(),
    iat,
    exp: iat + (opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS),
  };
  const header = { alg: "EdDSA", typ: "JWT", kid: opts.key.kid };
  const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  const privateKey = createPrivateKey({ key: opts.key.privateJwk, format: "jwk" });
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return { token: `${signingInput}.${b64(signature)}`, claims };
}

const parse = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface VerifyAccessTokenOptions {
  keys: VerificationKey[];
  /** The app the token must be for. A token for another app is refused. */
  audience: string;
  now?: Date;
  /** Clock difference tolerated, in seconds. Default ACCESS_TOKEN_SKEW_SECONDS; 0 where the verifier shares the issuer's clock. */
  skewSeconds?: number;
}

/** Verify signature, issuer, audience and expiry. Never throws: a bad token is a `reason`. */
export function verifyAccessToken(token: string, opts: VerifyAccessTokenOptions): VerifyResult {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];

  const header = parse(h);
  // Only EdDSA: never "none", never an algorithm the token itself picks.
  if (!isObject(header) || header.alg !== "EdDSA" || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const key = opts.keys.find((k) => k.kid === header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: key.publicJwk, format: "jwk" });
  } catch {
    return { ok: false, reason: "unknown_key" };
  }
  if (!verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))) {
    return { ok: false, reason: "bad_signature" };
  }

  const c = parse(p);
  if (
    !isObject(c) ||
    c.iss !== ACCESS_TOKEN_ISSUER ||
    typeof c.sub !== "string" ||
    typeof c.aud !== "string" ||
    !Array.isArray(c.roles) ||
    !c.roles.every((x) => typeof x === "string") ||
    !Array.isArray(c.perms) ||
    !c.perms.every((x) => typeof x === "string") ||
    !Number.isInteger(c.iat) ||
    !Number.isInteger(c.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const claims = c as unknown as AccessClaims;
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (claims.aud !== opts.audience) return { ok: false, reason: "wrong_audience" };
  const skew = opts.skewSeconds ?? ACCESS_TOKEN_SKEW_SECONDS;
  if (claims.exp <= nowSeconds - skew) return { ok: false, reason: "expired" };
  // A token from the future is as untrustworthy as an expired one.
  if (claims.iat > nowSeconds + skew) return { ok: false, reason: "malformed" };
  return { ok: true, claims };
}

/** The public half of a signing key, as a JWKS entry. */
export function verificationKeyOf(key: SigningKey): VerificationKey {
  const { x } = key.privateJwk;
  return { kid: key.kid, publicJwk: { kty: "OKP", crv: "Ed25519", x } };
}

/** The JWKS document core-api serves at /.well-known/jwks.json. */
export function jwksOf(keys: VerificationKey[]) {
  return { keys: keys.map((k) => ({ ...k.publicJwk, kid: k.kid, alg: "EdDSA", use: "sig" })) };
}
