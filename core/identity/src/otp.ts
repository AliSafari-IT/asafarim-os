/**
 * One-time codes for the SMS sign-in method, and the rate limits around them.
 *
 * - A code is 6 random digits, valid for OTP_TTL_SECONDS and usable once.
 * - It is never stored: Redis holds an HMAC of (challenge id, phone, code)
 *   under the server's IDENTITY_OTP_SECRET, so a Redis dump reveals no code
 *   and a challenge can't be redeemed for another number.
 * - Each challenge allows OTP_MAX_ATTEMPTS wrong tries, then it is deleted.
 *   Checking, counting and deleting happen in one Redis step, so parallel
 *   guesses can't exceed the limit and a correct code works exactly once.
 */
import { createHmac, randomBytes, randomInt } from "node:crypto";
import type { Redis } from "ioredis";
import { KEY_PREFIX } from "./redis-adapter.ts";

export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LENGTH = 6;

export function generateCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

export function newChallengeId(): string {
  return randomBytes(16).toString("base64url");
}

/** The stored form of a code: bound to its challenge and its phone number. */
export function hashCode(secret: string, challengeId: string, phone: string, code: string): string {
  return createHmac("sha256", secret).update(`otp\0${challengeId}\0${phone}\0${code}`).digest("base64url");
}

/**
 * A keyed, one-way handle for an identifier (a phone number, an IP address)
 * where a stable key is needed but the value itself must not be stored: rate
 * limit keys and the audit trail of attempts on numbers nobody has proved.
 */
export function blindHandle(secret: string, kind: string, value: string): string {
  return createHmac("sha256", secret).update(`${kind}\0${value}`).digest("base64url").slice(0, 32);
}

export function isCodeShaped(value: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(value);
}

export type VerifyResult = "ok" | "wrong" | "exhausted" | "missing";

export interface OtpChallenges {
  create(challengeId: string, codeHash: string): Promise<void>;
  /** Atomic: "ok" deletes the challenge; the last wrong try deletes it too ("exhausted"). */
  verify(challengeId: string, codeHash: string): Promise<VerifyResult>;
}

const VERIFY = `
local v = redis.call('GET', KEYS[1])
if not v then return 'missing' end
local ok, c = pcall(cjson.decode, v)
if not ok or type(c) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return 'missing'
end
if c['hash'] == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 'ok'
end
local attempts = (tonumber(c['attempts']) or 0) + 1
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return 'exhausted'
end
c['attempts'] = attempts
redis.call('SET', KEYS[1], cjson.encode(c), 'KEEPTTL')
return 'wrong'`;

export class RedisOtpChallenges implements OtpChallenges {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  private key(challengeId: string) {
    return `${KEY_PREFIX}sms-otp:${challengeId}`;
  }

  async create(challengeId: string, codeHash: string): Promise<void> {
    await this.client.set(
      this.key(challengeId),
      JSON.stringify({ hash: codeHash, attempts: 0 }),
      "EX",
      OTP_TTL_SECONDS,
      "NX",
    );
  }

  async verify(challengeId: string, codeHash: string): Promise<VerifyResult> {
    const out = await this.client.eval(VERIFY, 1, this.key(challengeId), codeHash, String(OTP_MAX_ATTEMPTS));
    return out === "ok" || out === "wrong" || out === "exhausted" ? out : "missing";
  }
}

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowSeconds: number;
}

export interface LimitResult {
  allowed: boolean;
  /** Seconds until the window resets (only meaningful when refused). */
  retryAfter: number;
}

export interface RateLimiter {
  /** Counts one request against `bucket`/`id` and says whether it is within `limit`. */
  hit(bucket: string, id: string, limit: Limit): Promise<LimitResult>;
  /** A one-shot cooldown: true if none was running (and starts one), false while one runs. */
  cooldown(bucket: string, id: string, seconds: number): Promise<boolean>;
}

const HIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}`;

/** Fixed windows in Redis. `id` is already a blind handle, never a raw number or address. */
export class RedisRateLimiter implements RateLimiter {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  async hit(bucket: string, id: string, limit: Limit): Promise<LimitResult> {
    const [count, ttl] = (await this.client.eval(
      HIT,
      1,
      `${KEY_PREFIX}sms-rl:${bucket}:${id}`,
      String(limit.windowSeconds),
    )) as [number, number];
    return { allowed: count <= limit.max, retryAfter: Math.max(1, ttl) };
  }

  async cooldown(bucket: string, id: string, seconds: number): Promise<boolean> {
    const set = await this.client.set(`${KEY_PREFIX}sms-cd:${bucket}:${id}`, "1", "EX", seconds, "NX");
    return set === "OK";
  }
}

/** The limits of the SMS sign-in. Per phone and per IP, plus a global daily SMS budget. */
export const LIMITS = {
  sendPerPhone: { max: 3, windowSeconds: 15 * 60 },
  sendPerPhoneDaily: { max: 10, windowSeconds: 24 * 3600 },
  sendPerIp: { max: 10, windowSeconds: 3600 },
  verifyPerIp: { max: 30, windowSeconds: 3600 },
  verifyPerPhone: { max: 15, windowSeconds: 3600 },
  flowsPerIp: { max: 60, windowSeconds: 3600 },
  resendCooldownSeconds: 60,
} as const satisfies Record<string, Limit | number>;
