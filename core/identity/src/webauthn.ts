/**
 * Passkeys (WebAuthn Level 2) on the server, with no dependency: building the
 * options the browser needs, and verifying what it sends back.
 *
 * Registration (attestation `none`: we trust the person adding it, who is
 * already signed in, not the device's maker): client data type, challenge
 * (single use, checked by the caller's store), origin, the rpId hash, user
 * presence AND user verification, then the credential id and its COSE public
 * key, kept as a JWK.
 *
 * Authentication: the same checks, plus the signature over
 * authenticatorData ‖ SHA-256(clientDataJSON) with the stored key, the sign
 * counter (a counter that doesn't move forward means a cloned key: refused),
 * and the user handle, when sent, must be the credential's owner.
 *
 * Algorithms: ES256 (-7), EdDSA (-8), RS256 (-257, at least 2048 bits).
 */
import { constants, createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { type CborMap, type CborValue, decodeCbor } from "./cbor.ts";

/** A public JWK (EC, OKP or RSA): string members only. */
export type Jwk = Record<string, string>;

export const ALGORITHMS = [-7, -8, -257] as const;
export const CEREMONY_TIMEOUT_MS = 120_000;

export interface RelyingParty {
  /** The host the passkeys belong to: the issuer's hostname. */
  id: string;
  /** The exact origin the browser must report: the issuer's origin. */
  origin: string;
  name: string;
}

export class WebAuthnError extends Error {
  /** A short code for logs and the audit trail. */
  readonly code: string;

  constructor(code: string) {
    super(`passkey refused (${code})`);
    this.name = "WebAuthnError";
    this.code = code;
  }
}

const B64URL = /^[A-Za-z0-9_-]*$/;

export function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64url(value: unknown, field: string, maxBytes = 16 * 1024): Buffer {
  if (typeof value !== "string" || !B64URL.test(value) || value.length > Math.ceil((maxBytes * 4) / 3)) {
    throw new WebAuthnError(`bad_${field}`);
  }
  return Buffer.from(value, "base64url");
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- options for the browser ---------------------------------------------------------------------

export function registrationOptions(
  rp: RelyingParty,
  user: { id: string; name: string; displayName: string },
  challenge: string,
  excludeCredentialIds: readonly string[],
) {
  return {
    rp: { id: rp.id, name: rp.name },
    user: { id: toB64url(Buffer.from(user.id, "utf8")), name: user.name, displayName: user.displayName },
    challenge,
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
    timeout: CEREMONY_TIMEOUT_MS,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: excludeCredentialIds.map((id) => ({ type: "public-key", id })),
  };
}

export function authenticationOptions(rp: RelyingParty, challenge: string) {
  // No allowCredentials: discoverable passkeys, so the browser offers this person's own and no
  // list of credentials (nor whether an account exists) is revealed before they choose.
  return { rpId: rp.id, challenge, timeout: CEREMONY_TIMEOUT_MS, userVerification: "required" };
}

// ---- parsing ---------------------------------------------------------------------------------------

function checkClientData(raw: Buffer, type: string, challenge: string, rp: RelyingParty) {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    data = JSON.parse(raw.toString("utf8")) as typeof data;
  } catch {
    throw new WebAuthnError("bad_client_data");
  }
  if (data.type !== type) throw new WebAuthnError("wrong_type");
  if (typeof data.challenge !== "string" || !sameBytes(Buffer.from(data.challenge), Buffer.from(challenge))) {
    throw new WebAuthnError("wrong_challenge");
  }
  if (data.origin !== rp.origin) throw new WebAuthnError("wrong_origin");
  if (data.crossOrigin === true) throw new WebAuthnError("cross_origin");
}

interface AuthData {
  signCount: number;
  credentialId?: Buffer;
  publicKey?: CborMap;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function parseAuthData(data: Buffer, rp: RelyingParty, expectCredential: boolean): AuthData {
  if (data.length < 37) throw new WebAuthnError("bad_authenticator_data");
  if (!sameBytes(data.subarray(0, 32), sha256(Buffer.from(rp.id, "utf8")))) throw new WebAuthnError("wrong_rp");
  const flags = data[32]!;
  if (!(flags & FLAG_UP)) throw new WebAuthnError("no_user_presence");
  if (!(flags & FLAG_UV)) throw new WebAuthnError("no_user_verification");
  const signCount = data.readUInt32BE(33);
  if (!expectCredential) return { signCount };
  if (!(flags & FLAG_AT) || data.length < 55) throw new WebAuthnError("no_credential");
  const idLength = data.readUInt16BE(53);
  if (idLength < 16 || idLength > 1023 || data.length < 55 + idLength + 1) throw new WebAuthnError("bad_credential_id");
  const credentialId = data.subarray(55, 55 + idLength);
  let key: CborValue;
  try {
    key = decodeCbor(data, 55 + idLength).value;
  } catch {
    throw new WebAuthnError("bad_public_key");
  }
  if (!(key instanceof Map)) throw new WebAuthnError("bad_public_key");
  return { signCount, credentialId: Buffer.from(credentialId), publicKey: key };
}

const bytesAt = (key: CborMap, label: number): Uint8Array => {
  const v = key.get(label);
  if (!(v instanceof Uint8Array)) throw new WebAuthnError("bad_public_key");
  return v;
};

/** A COSE_Key → a JWK and its algorithm. Only the three algorithms offered are accepted. */
export function coseToJwk(key: CborMap): { jwk: Jwk; alg: number } {
  const kty = key.get(1);
  const alg = key.get(3);
  if (kty === 2 && alg === -7 && key.get(-1) === 1) {
    const x = bytesAt(key, -2);
    const y = bytesAt(key, -3);
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("bad_public_key");
    return { jwk: { kty: "EC", crv: "P-256", x: toB64url(x), y: toB64url(y) }, alg };
  }
  if (kty === 1 && alg === -8 && key.get(-1) === 6) {
    const x = bytesAt(key, -2);
    if (x.length !== 32) throw new WebAuthnError("bad_public_key");
    return { jwk: { kty: "OKP", crv: "Ed25519", x: toB64url(x) }, alg };
  }
  if (kty === 3 && alg === -257) {
    const n = bytesAt(key, -1);
    const e = bytesAt(key, -2);
    if (n.length < 256) throw new WebAuthnError("weak_public_key");
    return { jwk: { kty: "RSA", n: toB64url(n), e: toB64url(e) }, alg };
  }
  throw new WebAuthnError("unsupported_algorithm");
}

interface Body {
  id?: unknown;
  rawId?: unknown;
  type?: unknown;
  response?: Record<string, unknown>;
}

function bodyOf(input: unknown): Body & { response: Record<string, unknown> } {
  if (!input || typeof input !== "object") throw new WebAuthnError("bad_request");
  const body = input as Body;
  if (body.type !== "public-key" || !body.response || typeof body.response !== "object") {
    throw new WebAuthnError("bad_request");
  }
  return body as Body & { response: Record<string, unknown> };
}

// ---- registration -----------------------------------------------------------------------------------

export interface NewPasskey {
  credentialId: string;
  publicKey: Jwk;
  alg: number;
  signCount: number;
  transports: string[];
}

export function verifyRegistration(rp: RelyingParty, challenge: string, input: unknown): NewPasskey {
  const body = bodyOf(input);
  const rawId = fromB64url(body.rawId, "id", 1024);
  checkClientData(fromB64url(body.response.clientDataJSON, "client_data"), "webauthn.create", challenge, rp);
  let attestation: CborValue;
  try {
    attestation = decodeCbor(fromB64url(body.response.attestationObject, "attestation")).value;
  } catch (err) {
    throw err instanceof WebAuthnError ? err : new WebAuthnError("bad_attestation");
  }
  const authData = attestation instanceof Map ? attestation.get("authData") : undefined;
  if (!(authData instanceof Uint8Array)) throw new WebAuthnError("bad_attestation");
  const parsed = parseAuthData(Buffer.from(authData), rp, true);
  if (!sameBytes(parsed.credentialId!, rawId)) throw new WebAuthnError("credential_id_mismatch");
  const { jwk, alg } = coseToJwk(parsed.publicKey!);
  try {
    createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new WebAuthnError("bad_public_key");
  }
  const transports = Array.isArray(body.response.transports)
    ? body.response.transports.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,16}$/.test(t)).slice(0, 8)
    : [];
  return { credentialId: toB64url(rawId), publicKey: jwk, alg, signCount: parsed.signCount, transports };
}

// ---- authentication -------------------------------------------------------------------------------

export interface StoredPasskey {
  principalId: string;
  publicKey: Jwk;
  alg: number;
  signCount: number;
}

/** The credential id the browser says it used (to look the passkey up before verifying). */
export function assertionCredentialId(input: unknown): string {
  return toB64url(fromB64url(bodyOf(input).rawId, "id", 1024));
}

/** Verifies an assertion against the stored passkey; returns the new sign count to store. */
export function verifyAuthentication(
  rp: RelyingParty,
  challenge: string,
  input: unknown,
  stored: StoredPasskey,
): { signCount: number } {
  const body = bodyOf(input);
  const clientData = fromB64url(body.response.clientDataJSON, "client_data");
  checkClientData(clientData, "webauthn.get", challenge, rp);
  const authData = fromB64url(body.response.authenticatorData, "authenticator_data");
  const parsed = parseAuthData(authData, rp, false);
  const signature = fromB64url(body.response.signature, "signature", 1024);
  if (body.response.userHandle !== undefined && body.response.userHandle !== null) {
    const handle = fromB64url(body.response.userHandle, "user_handle", 128).toString("utf8");
    if (handle !== stored.principalId) throw new WebAuthnError("wrong_user");
  }
  const key = createPublicKey({ key: stored.publicKey, format: "jwk" });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  let ok: boolean;
  try {
    if (stored.alg === -7) ok = verify("sha256", signed, { key, dsaEncoding: "der" }, signature);
    else if (stored.alg === -8) ok = verify(null, signed, key, signature);
    else if (stored.alg === -257)
      ok = verify("sha256", signed, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
    else throw new WebAuthnError("unsupported_algorithm");
  } catch (err) {
    if (err instanceof WebAuthnError) throw err;
    ok = false;
  }
  if (!ok) throw new WebAuthnError("bad_signature");
  // Counters: authenticators that don't count send 0 every time; one that counts must move forward.
  if ((parsed.signCount !== 0 || stored.signCount !== 0) && parsed.signCount <= stored.signCount) {
    throw new WebAuthnError("counter_not_increased");
  }
  return { signCount: parsed.signCount };
}
