/**
 * The signed NATS connect assertion (P4.1 PR 4, ADR 0001 §5). An app connects to the event bus with
 *
 *   user = <appId>
 *   pass = v1.<keyId>.<unix-seconds>.<nonce>.<signature>
 *
 * where <signature> is the base64url Ed25519 signature, made with the app's registry credential,
 * over the canonical string
 *   nats-connect\n<appId>\n<unix-seconds>\n<nonce>
 * core-api (the NATS auth callout) verifies it: the key belongs to <appId> and isn't revoked, the
 * timestamp is within ±SIGNATURE_WINDOW_SECONDS, and the nonce was never used before. No second
 * secret: it is the same key that signs registrations.
 *
 * <keyId> itself contains a dot (`notes.0123456789ab`), so the assertion is parsed from the right.
 */
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { NONCE_PATTERN, parseCredential } from "./index.ts";

export const NATS_CONNECT_VERSION = "v1";

export const natsConnectCanonical = (appId: string, timestamp: string, nonce: string) =>
  `nats-connect\n${appId}\n${timestamp}\n${nonce}`;

export interface NatsConnectAssertion {
  keyId: string;
  timestamp: string;
  nonce: string;
  /** base64url */
  signature: string;
}

/** Sign a connect assertion for `appId` with the app's credential (`osk1.…`). */
export function signNatsConnect(opts: { appId: string; credential: string; now?: Date; nonce?: string }): string {
  const { keyId, privateKeyDer } = parseCredential(opts.credential);
  if (!keyId.startsWith(`${opts.appId}.`)) throw new Error(`the credential isn't for app "${opts.appId}"`);
  const timestamp = String(Math.floor((opts.now ?? new Date()).getTime() / 1000));
  const nonce = opts.nonce ?? randomBytes(18).toString("base64url");
  const key = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(natsConnectCanonical(opts.appId, timestamp, nonce)), key);
  return [NATS_CONNECT_VERSION, keyId, timestamp, nonce, signature.toString("base64url")].join(".");
}

/** The parts of an assertion, or undefined when it is malformed. Checks the shape only, never the signature. */
export function parseNatsConnect(pass: string | undefined): NatsConnectAssertion | undefined {
  if (!pass || pass.length > 512 || !pass.startsWith(`${NATS_CONNECT_VERSION}.`)) return undefined;
  const parts = pass.slice(NATS_CONNECT_VERSION.length + 1).split(".");
  if (parts.length < 4) return undefined;
  const signature = parts.pop()!;
  const nonce = parts.pop()!;
  const timestamp = parts.pop()!;
  const keyId = parts.join(".");
  if (!/^[a-z0-9-]+\.[0-9a-f]{12}$/.test(keyId)) return undefined;
  if (!/^\d{1,12}$/.test(timestamp)) return undefined;
  if (!NONCE_PATTERN.test(nonce)) return undefined;
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(signature)) return undefined;
  return { keyId, timestamp, nonce, signature };
}
