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
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";

import {
  NONCE_PATTERN,
  SIGNATURE_WINDOW_SECONDS,
  canonicalString,
  parseCredential,
  signRequest,
} from "@asafarim/registry-protocol";

// The signing protocol itself lives in @asafarim/registry-protocol (shared
// with the app SDK); re-exported so core-api's own code and tests keep one import.
export { NONCE_PATTERN, SIGNATURE_WINDOW_SECONDS, canonicalString, parseCredential, signRequest };

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

/** Kept for the tests and the CLI: a signed POST to the registration endpoint. */
export function signRegistration(opts: {
  appId: string;
  credential: string;
  body: string;
  now?: Date;
  nonce?: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    ...signRequest({
      credential: opts.credential,
      method: "POST",
      path: `/registry/v1/apps/${opts.appId}`,
      body: opts.body,
      now: opts.now,
      nonce: opts.nonce,
    }),
  };
}
