/**
 * Sliding-window rate limiting for the guest-reachable routes (likes/toggle: 15 requests a minute per client).
 *
 * `createRedisRateLimiter` keeps one sorted set per key (member = a request, score = its time) and decides in ONE
 * atomic Lua script, so several app instances share the count. Redis is injected through `RedisLike` (ioredis
 * satisfies it) so this package has no Redis dependency of its own. `createMemoryRateLimiter` has the same
 * contract for development, tests and single-process use.
 *
 * If Redis fails, the default is to ALLOW the request and report the error (`failOpen`): the database's unique
 * indexes still make a duplicate like impossible, and a Redis outage should not switch likes off. Set
 * `failOpen: false` to refuse instead.
 */
import { randomUUID } from "node:crypto";

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** Count one request for `key` and say whether it is within the limit. */
  hit(key: string): Promise<RateLimitResult>;
}

/** The part of an ioredis client this uses: EVAL with `numKeys` keys, then the arguments. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface WindowOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

function assertWindow(o: WindowOptions): void {
  if (!Number.isInteger(o.limit) || o.limit < 1) throw new Error("limit must be a positive integer");
  if (!Number.isInteger(o.windowMs) || o.windowMs < 1) throw new Error("windowMs must be a positive integer");
}

/**
 * KEYS[1] = the key; ARGV = [windowMs, limit, member]. The time comes from Redis itself (TIME), so instances with
 * different clocks agree. Returns {1, remaining} when allowed, {0, retryAfterMs} when not.
 */
export const SLIDING_WINDOW_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = window - (now - tonumber(oldest[2]))
  if retry < 1 then retry = 1 end
  return {0, retry}
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return {1, limit - count - 1}
`;

export interface RedisRateLimiterOptions extends WindowOptions {
  redis: RedisLike;
  /** Key prefix, so apps sharing one Redis never share counters. Default "engagement:rl:". */
  prefix?: string;
  /** Allow the request when Redis fails (default true). */
  failOpen?: boolean;
  /** Called with the error when Redis fails. */
  onError?: (err: unknown) => void;
}

export function createRedisRateLimiter(opts: RedisRateLimiterOptions): RateLimiter {
  assertWindow(opts);
  const prefix = opts.prefix ?? "engagement:rl:";
  const failOpen = opts.failOpen ?? true;
  return {
    async hit(key) {
      try {
        const raw = await opts.redis.eval(
          SLIDING_WINDOW_SCRIPT,
          1,
          prefix + key,
          opts.windowMs,
          opts.limit,
          randomUUID(),
        );
        if (!Array.isArray(raw) || raw.length < 2) throw new Error("unexpected reply from the rate limit script");
        const allowed = Number(raw[0]) === 1;
        const n = Number(raw[1]);
        if (!Number.isFinite(n)) throw new Error("unexpected reply from the rate limit script");
        return allowed
          ? { ok: true, remaining: n }
          : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(n / 1000)) };
      } catch (err) {
        opts.onError?.(err);
        return failOpen ? { ok: true, remaining: 0 } : { ok: false, retryAfterSeconds: 1 };
      }
    },
  };
}

export interface MemoryRateLimiterOptions extends WindowOptions {
  /** Bounded memory: the oldest-seen key is dropped when full. Default 10 000. */
  maxKeys?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export function createMemoryRateLimiter(opts: MemoryRateLimiterOptions): RateLimiter {
  assertWindow(opts);
  const maxKeys = opts.maxKeys ?? 10_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    async hit(key) {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((t) => t > at - opts.windowMs);
      if (recent.length >= opts.limit) {
        hits.set(key, recent);
        const retry = opts.windowMs - (at - recent[0]!);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retry / 1000)) };
      }
      recent.push(at);
      hits.delete(key); // re-insert so the Map's order is least-recently-used first
      if (hits.size >= maxKeys) hits.delete(hits.keys().next().value!);
      hits.set(key, recent);
      return { ok: true, remaining: opts.limit - recent.length };
    },
  };
}
