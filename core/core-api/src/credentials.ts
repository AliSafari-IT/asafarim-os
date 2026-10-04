/**
 * Registry credentials and the signed self-registration request (P3.1).
 *
 * Scheme "ed25519-v1" (proposed on asafarim-platform#723, pending the
 * architect): install generates an Ed25519 key pair, shows the PRIVATE key
 * once (the app's credential) and stores only the PUBLIC key. Nothing secret
 * is at rest in core-api, so a database leak can't forge a registration.
 * The scheme sits behind `CredentialScheme`, so an HMAC variant can replace
 * it without touching the registry.
 *
 * Signed request (POST /registry/v1/apps/<id>):
 *   x-asafarim-timestamp   unix seconds; accepted within ±60 s
 *   x-asafarim-nonce       16+ random bytes, base64url; single use
 *   x-asafarim-key-id      which credential signed
 *   x-asafarim-signature   v1=<base64url signature>
 * over the canonical string
 *   v1\n<timestamp>\n<nonce>\nPOST\n/registry/v1/apps/<id>\n<sha256(body) hex>
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export const SIGNATURE_WINDOW_SECONDS = 60;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

export interface IssuedCredential {
  keyId: string;
  scheme: string;
  /** Stored by core-api: enough to verify, useless for signing. */
  verifier: string;
  /** Given to the app once, never stored. */
  secret: string;
}

export interface CredentialScheme {
  readonly name: string;
  issue(appId: string): IssuedCredential;
  verify(verifier: string, message: string, signature: Buffer): boolean;
}

export const ed25519Scheme: CredentialScheme = {
  name: "ed25519-v1",
  issue(appId) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = `${appId}.${randomBytes(6).toString("hex")}`;
    return {
      keyId,
      scheme: "ed25519-v1",
      verifier: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      // The credential string the app keeps: key id + PKCS#8 private key.
      secret: `osk1.${keyId}.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`,
    };
  },
  verify(verifier, message, signature) {
    try {
      const key = createPublicKey({ key: Buffer.from(verifier, "base64url"), format: "der", type: "spki" });
      return verify(null, Buffer.from(message), key, signature);
    } catch {
      return false;
    }
  },
};

export function canonicalString(timestamp: string, nonce: string, appId: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `v1\n${timestamp}\n${nonce}\nPOST\n/registry/v1/apps/${appId}\n${bodyHash}`;
}

/** Parse "osk1.<keyId>.<pkcs8>" (what install printed). */
export function parseCredential(secret: string): { keyId: string; privateKeyDer: Buffer } {
  const m = /^osk1\.([a-z0-9-]+\.[0-9a-f]{12})\.([A-Za-z0-9_-]+)$/.exec(secret);
  if (!m) throw new Error("not an ASafariM OS registry credential (osk1.…)");
  return { keyId: m[1]!, privateKeyDer: Buffer.from(m[2]!, "base64url") };
}

/**
 * The headers an app sends with its registration (the SDK's job; exported
 * for the CLI and tests).
 */
export function signRegistration(opts: {
  appId: string;
  credential: string;
  body: string;
  now?: Date;
  nonce?: string;
}): Record<string, string> {
  const { keyId, privateKeyDer } = parseCredential(opts.credential);
  const timestamp = String(Math.floor((opts.now ?? new Date()).getTime() / 1000));
  const nonce = opts.nonce ?? randomBytes(18).toString("base64url");
  const key = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(canonicalString(timestamp, nonce, opts.appId, opts.body)), key);
  return {
    "content-type": "application/json",
    "x-asafarim-timestamp": timestamp,
    "x-asafarim-nonce": nonce,
    "x-asafarim-key-id": keyId,
    "x-asafarim-signature": `v1=${signature.toString("base64url")}`,
  };
}
