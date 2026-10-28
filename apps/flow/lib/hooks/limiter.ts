/**
 * The hooks' rate limit: at most 60 calls a minute per hook, over a sliding minute.
 *
 * Counted in memory, per process, not in Postgres: the limit is there to keep a flood off the database
 * and the engine, and counting in Postgres would put a write on the database for every call, the
 * flood included. Flow runs as one instance (the VPS is shared); with more, each counts its own, and a
 * restart starts the count over. Only hooks that exist are counted, so the map holds at most one entry
 * per hook.
 */
export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60_000;

export interface RateLimiter {
  /** Count a call to `key` at `now`: false when it is over the limit (and then it isn't counted). */
  take(key: string, now: number): boolean;
}

export function createRateLimiter(limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS): RateLimiter {
  const calls = new Map<string, number[]>();
  return {
    take(key, now) {
      const recent = (calls.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        calls.set(key, recent);
        return false;
      }
      recent.push(now);
      calls.set(key, recent);
      return true;
    },
  };
}
