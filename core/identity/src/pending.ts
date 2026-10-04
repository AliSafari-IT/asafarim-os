/**
 * Verified-but-unfinished logins (two-step completion, asafarim-platform#723
 * review of #23). Hub's assertion arrives as a cross-site POST that can't
 * prove which browser started the interaction, so the POST only parks the
 * verified `sub` here, keyed by the interaction uid, for 60 s, single-use,
 * together with the SHA-256 of a completion secret it hands to the posting
 * browser as a cookie. GET /interaction/:uid/complete finishes the login only
 * in a browser holding BOTH the provider's interaction cookie (it started the
 * interaction) and that completion cookie (it posted the assertion).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import { KEY_PREFIX } from "./redis-adapter.ts";

export const PENDING_TTL_SECONDS = 60;

export interface PendingLogin {
  sub: string;
  /** base64url SHA-256 of the completion secret. */
  completionHash: string;
}

export interface PendingLogins {
  put(uid: string, login: PendingLogin, ttlSeconds: number): Promise<void>;
  /**
   * Compare-and-delete: returns and deletes the pending login ONLY if `secret`
   * hashes to its completionHash, atomically. A wrong or missing secret leaves
   * it untouched, so a request that only knows the uid can't burn someone
   * else's sign-in (CodeRabbit on #24). Still single use: a match deletes it.
   */
  takeIfSecret(uid: string, secret: string): Promise<PendingLogin | null>;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

/** Constant-time check that `secret` hashes to `expectedHash`. */
export function secretMatches(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret));
  const b = Buffer.from(expectedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET + compare + DEL in one Redis step. Only the hash crosses the wire; the
 * comparison of two base64url hashes inside Redis leaks nothing useful.
 */
const COMPARE_AND_DELETE = `
local v = redis.call('GET', KEYS[1])
if not v then return false end
local ok, login = pcall(cjson.decode, v)
if not ok or login['completionHash'] ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return v`;

export class RedisPendingLogins implements PendingLogins {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  private key(uid: string) {
    return `${KEY_PREFIX}pending-login:${uid}`;
  }

  async put(uid: string, login: PendingLogin, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key(uid), JSON.stringify(login), "EX", ttlSeconds);
  }

  async takeIfSecret(uid: string, secret: string): Promise<PendingLogin | null> {
    const raw = (await this.client.eval(COMPARE_AND_DELETE, 1, this.key(uid), hashSecret(secret))) as string | null;
    if (!raw) return null;
    const login = JSON.parse(raw) as PendingLogin;
    // Belt and braces: the same check, constant-time, on our side.
    return secretMatches(secret, login.completionHash) ? login : null;
  }
}
