/**
 * The credentials' encryption: AES-256-GCM, a random 96-bit IV per encryption, the credential's id as
 * the additional authenticated data (a ciphertext copied onto another credential's row doesn't
 * decrypt), the 16-byte tag appended to the ciphertext.
 *
 * Keys come from the environment, base64 of 32 bytes each:
 *
 *   FLOW_CREDENTIALS_KEY            the current key: new and rotated credentials are sealed with it
 *   FLOW_CREDENTIALS_KEY_VERSION    its version (a positive integer; default 1), stored on each row
 *   FLOW_CREDENTIALS_PREVIOUS_KEYS  optional, "<version>:<base64>,…": older keys rows may still use
 *
 * A key that is missing or isn't valid leaves the credentials unavailable (never a crash):
 * keyringFromEnv says why, and the store refuses with `credentials_unavailable`.
 *
 * No local imports: scripts/rotate-credentials-key.mjs loads this file with Node's type stripping.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type CredentialErrorCode =
  "credentials_unavailable" | "credential_not_found" | "credential_kind_mismatch" | "credential_unreadable";

const MESSAGES: Record<CredentialErrorCode, string> = {
  credentials_unavailable: "Credentials aren't set up on this server.",
  credential_not_found: "The credential doesn't exist.",
  credential_kind_mismatch: "The credential isn't of the kind this connector needs.",
  credential_unreadable: "The credential can't be decrypted with the keys this server has.",
};

/** A refusal; its message is fixed text per code, never a value. */
export class CredentialError extends Error {
  readonly code: CredentialErrorCode;
  constructor(code: CredentialErrorCode) {
    super(MESSAGES[code]);
    this.name = "CredentialError";
    this.code = code;
  }
}

export interface Keyring {
  version: number;
  key: Buffer;
  /** Every key by version, the current one included. */
  keys: Map<number, Buffer>;
}

export type KeyState = { ok: true; keyring: Keyring } | { ok: false; reason: "missing" | "invalid" };

/** Standard base64 of exactly 32 bytes. */
export function decodeKey(b64: string | undefined): Buffer | undefined {
  if (!b64 || !/^[A-Za-z0-9+/]{43}=$/.test(b64.trim())) return undefined;
  const key = Buffer.from(b64.trim(), "base64");
  return key.length === 32 ? key : undefined;
}

const VERSION = /^[1-9]\d{0,8}$/;

export function keyringFromEnv(env: Record<string, string | undefined> = process.env): KeyState {
  if (!env.FLOW_CREDENTIALS_KEY?.trim()) return { ok: false, reason: "missing" };
  const key = decodeKey(env.FLOW_CREDENTIALS_KEY);
  const rawVersion = env.FLOW_CREDENTIALS_KEY_VERSION?.trim() || "1";
  if (!key || !VERSION.test(rawVersion)) return { ok: false, reason: "invalid" };
  const version = Number(rawVersion);
  const keys = new Map<number, Buffer>([[version, key]]);
  for (const entry of (env.FLOW_CREDENTIALS_PREVIOUS_KEYS ?? "").split(",").map((e) => e.trim())) {
    if (!entry) continue;
    const [v, b64] = entry.split(":");
    const old = decodeKey(b64);
    if (!v || !VERSION.test(v) || !old || keys.has(Number(v))) return { ok: false, reason: "invalid" };
    keys.set(Number(v), old);
  }
  return { ok: true, keyring: { version, key, keys } };
}

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  keyVersion: number;
}

export function seal(keyring: Keyring, id: string, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyring.key, iv);
  cipher.setAAD(Buffer.from(id, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), iv, keyVersion: keyring.version };
}

/** The plaintext; `credential_unreadable` when the key, the id or the bytes don't match. */
export function open(keyring: Keyring, id: string, sealed: Sealed): string {
  const key = keyring.keys.get(sealed.keyVersion);
  if (!key || sealed.iv.length !== 12 || sealed.ciphertext.length < 16)
    throw new CredentialError("credential_unreadable");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
    decipher.setAAD(Buffer.from(id, "utf8"));
    decipher.setAuthTag(sealed.ciphertext.subarray(-16));
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialError("credential_unreadable");
  }
}

interface Client {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Re-encrypt every credential not sealed with the current key, in one transaction (rows locked);
 * how many. A row no key of the keyring opens stops it, and nothing is changed.
 */
export async function reencryptAll(client: Client, keyring: Keyring): Promise<number> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      "SELECT id, ciphertext, iv, key_version FROM credentials WHERE key_version <> $1 FOR UPDATE",
      [keyring.version],
    );
    for (const r of rows) {
      const id = r.id as string;
      const plaintext = open(keyring, id, {
        ciphertext: r.ciphertext as Buffer,
        iv: r.iv as Buffer,
        keyVersion: r.key_version as number,
      });
      const next = seal(keyring, id, plaintext);
      await client.query("UPDATE credentials SET ciphertext = $2, iv = $3, key_version = $4 WHERE id = $1", [
        id,
        next.ciphertext,
        next.iv,
        next.keyVersion,
      ]);
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
