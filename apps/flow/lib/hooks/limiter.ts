/**
 * The hooks' rate limits, over a sliding minute: at most 60 calls a minute per hook, and 600 a minute
 * in all (unknown ids included, so a flood of them can't drive a lookup per call).
 *
 * Counted in memory, per process, not in Postgres: the limit is there to keep a flood off the database
 * and the engine, and counting in Postgres would put a write on the database for every call, the
 * flood included. Flow runs as one instance (the VPS is shared); with more, each counts its own, and a
 * restart starts the count over. The per-hook limiter counts only hooks that exist, so its map holds at
 * most one entry per hook; the global one has a single key.
 */
export const RATE_LIMIT = 60;
/** All calls together, hooks that exist or not: checked before the hook is looked up. */
export const GLOBAL_RATE_LIMIT = 600;
/**
 * One source address, hooks that exist or not: checked first of all, so a single sender that floods
 * can't use up the shared allowance above. Behind the edge proxy the address is the one the proxy
 * appended (see `sourceOf` in receive.ts).
 */
export const SOURCE_RATE_LIMIT = 120;
/** How many source addresses are remembered at once (the oldest go first). */
export const SOURCE_KEYS_MAX = 10_000;
export const RATE_WINDOW_MS = 60_000;

export interface RateLimiter {
  /** Count a call to `key` at `now`: false when it is over the limit (and then it isn't counted). */
  take(key: string, now: number): boolean;
}

/** Drop what has expired, then (still over `maxKeys`) the entries that came first. */
function trim<V>(map: Map<string, V>, maxKeys: number, expired: (v: V) => boolean) {
  if (map.size < maxKeys) return;
  for (const [k, v] of map) if (expired(v)) map.delete(k);
  for (const k of map.keys()) {
    if (map.size < maxKeys) break;
    map.delete(k);
  }
}

/** `maxKeys` bounds the memory a flood of distinct keys (source addresses) can take. */
export function createRateLimiter(
  limit = RATE_LIMIT,
  windowMs = RATE_WINDOW_MS,
  maxKeys = Number.POSITIVE_INFINITY,
): RateLimiter {
  const calls = new Map<string, number[]>();
  return {
    take(key, now) {
      if (!calls.has(key)) trim(calls, maxKeys, (ts) => ts.every((t) => now - t >= windowMs));
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

/** What a hook was called with recently: a signature seen is a replay. */
export interface SeenStore {
  has(key: string, now: number): boolean;
  add(key: string, now: number): void;
  /** Give a claim back (nothing was started under it). */
  delete(key: string): void;
}

/**
 * Remember a day: a generic signature is good for ±5 minutes, a GitHub one has no clock at all. This is
 * a known gap, not a guarantee: after the day, or after a restart (the memory is per process), the same
 * signed GitHub body under a new delivery id starts another run. A durable key would need a table.
 */
export const REPLAY_TTL_MS = 24 * 60 * 60_000;
export const REPLAY_KEYS_MAX = 50_000;

/**
 * Signatures seen, in memory, per process (like the rate limits above: one instance, a restart starts
 * over). The engine remembers deliveries for good (the trigger event id); this covers what the
 * delivery id can't: a sender-controlled header that isn't signed, changed on an otherwise identical,
 * signed call.
 */
export function createSeenStore(ttlMs = REPLAY_TTL_MS, maxKeys = REPLAY_KEYS_MAX): SeenStore {
  const seen = new Map<string, number>();
  return {
    has: (key, now) => {
      const at = seen.get(key);
      return at !== undefined && now - at < ttlMs;
    },
    add(key, now) {
      if (!seen.has(key)) trim(seen, maxKeys, (at) => now - at >= ttlMs);
      seen.set(key, now);
    },
    delete: (key) => void seen.delete(key),
  };
}
