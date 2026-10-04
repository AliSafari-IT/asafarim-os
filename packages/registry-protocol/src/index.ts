/**
 * The app ↔ core-api signing protocol (ed25519-v1). Used by core-api to
 * VERIFY and by @asafarim/app-sdk to SIGN; nothing else lives here.
 *
 * Every signed request carries
 *   x-asafarim-timestamp   unix seconds (accepted within ±60 s)
 *   x-asafarim-nonce       22–128 base64url chars, random, single use
 *   x-asafarim-key-id      which credential signed
 *   x-asafarim-signature   v1=<base64url Ed25519 signature>
 * over the canonical string
 *   v1\n<timestamp>\n<nonce>\n<METHOD>\n<path>\n<sha256(body) hex>
 * where <path> is the exact request path (no query), and the body hash of an
 * empty body is the SHA-256 of "".
 */
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";

export const SIGNATURE_WINDOW_SECONDS = 60;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
export const SIGNATURE_HEADERS = [
  "x-asafarim-timestamp",
  "x-asafarim-nonce",
  "x-asafarim-key-id",
  "x-asafarim-signature",
] as const;

export function canonicalString(timestamp: string, nonce: string, method: string, path: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `v1\n${timestamp}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

/** Parse "osk1.<keyId>.<pkcs8>" (what `platform app install` printed). */
export function parseCredential(secret: string): { keyId: string; privateKeyDer: Buffer } {
  const m = /^osk1\.([a-z0-9-]+\.[0-9a-f]{12})\.([A-Za-z0-9_-]+)$/.exec(secret);
  if (!m) throw new Error("not an ASafariM OS registry credential (osk1.…)");
  return { keyId: m[1]!, privateKeyDer: Buffer.from(m[2]!, "base64url") };
}

export interface SignOptions {
  credential: string;
  method: string;
  /** The exact request path, e.g. /registry/v1/apps/notes (no query string). */
  path: string;
  body?: string;
  now?: Date;
  nonce?: string;
}

/** The headers to send with a signed request to core-api. */
export function signRequest(opts: SignOptions): Record<string, string> {
  const { keyId, privateKeyDer } = parseCredential(opts.credential);
  const timestamp = String(Math.floor((opts.now ?? new Date()).getTime() / 1000));
  const nonce = opts.nonce ?? randomBytes(18).toString("base64url");
  const key = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const message = canonicalString(timestamp, nonce, opts.method, opts.path, opts.body ?? "");
  const signature = sign(null, Buffer.from(message), key);
  return {
    "x-asafarim-timestamp": timestamp,
    "x-asafarim-nonce": nonce,
    "x-asafarim-key-id": keyId,
    "x-asafarim-signature": `v1=${signature.toString("base64url")}`,
  };
}

export * from "./access-token.ts";
