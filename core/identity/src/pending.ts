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
  /** Returns and deletes the pending login (single use). */
  take(uid: string): Promise<PendingLogin | null>;
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

  async take(uid: string): Promise<PendingLogin | null> {
    const raw = await this.client.getdel(this.key(uid));
    return raw ? (JSON.parse(raw) as PendingLogin) : null;
  }
}
