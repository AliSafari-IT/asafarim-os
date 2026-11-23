/**
 * A per-client token bucket for the public search (#357): a burst of `burst` requests, refilled at `perMinute`.
 * In memory, per process: Knowledge runs one instance, and the limit protects the database from one client's
 * flood, not from a distributed one (that is the edge's job). The client is the LAST X-Forwarded-For address,
 * the one the gateway (Caddy) appends; entries to its left come from the client and can be forged, so they never
 * key the limit (as in apps/flow). Without it, every request shares one bucket.
 */
export interface Limiter {
  take(key: string, now?: number): { ok: true } | { ok: false; retryAfterSeconds: number };
}

export function createLimiter(opts: { perMinute: number; burst: number; maxKeys?: number }): Limiter {
  const rate = opts.perMinute / 60_000;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key, now = Date.now()) {
      let b = buckets.get(key);
      if (!b) {
        // Bounded memory: drop the oldest-seen client when full (a Map iterates in insertion order).
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value!);
        b = { tokens: opts.burst, at: now };
        buckets.set(key, b);
      }
      b.tokens = Math.min(opts.burst, b.tokens + (now - b.at) * rate);
      b.at = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
    },
  };
}

/** The client address the gateway reported, or a shared key. */
export function clientKey(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return forwarded || headers.get("x-real-ip") || "unknown";
}

const g = globalThis as unknown as { knowledgeSearchLimiter?: Limiter };
/** The search limiter for this process: 30 searches a minute per client, bursts of 10. */
export const searchLimiter = (g.knowledgeSearchLimiter ??= createLimiter({ perMinute: 30, burst: 10 }));
