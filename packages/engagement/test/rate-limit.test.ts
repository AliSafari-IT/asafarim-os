import { describe, expect, it } from "vitest";
import {
  createMemoryRateLimiter,
  createRedisRateLimiter,
  SLIDING_WINDOW_SCRIPT,
  type RedisLike,
} from "../src/rate-limit.ts";

describe("createMemoryRateLimiter", () => {
  it("allows `limit` requests in a window, then refuses with a retry time", async () => {
    let now = 1_000_000;
    const rl = createMemoryRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(await rl.hit("a")).toEqual({ ok: true, remaining: 2 });
    now += 10_000;
    expect(await rl.hit("a")).toEqual({ ok: true, remaining: 1 });
    now += 10_000;
    expect(await rl.hit("a")).toEqual({ ok: true, remaining: 0 });
    now += 10_000;
    // The oldest hit (at t=0) leaves the window 60 s after it, i.e. in 30 s.
    expect(await rl.hit("a")).toEqual({ ok: false, retryAfterSeconds: 30 });
  });

  it("slides: a request is allowed again once the oldest has left the window", async () => {
    let now = 0;
    const rl = createMemoryRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    await rl.hit("a");
    now = 500;
    await rl.hit("a");
    now = 900;
    expect((await rl.hit("a")).ok).toBe(false);
    now = 1001; // the hit at t=0 is out; the one at t=500 is still in
    expect(await rl.hit("a")).toEqual({ ok: true, remaining: 0 });
    expect((await rl.hit("a")).ok).toBe(false);
  });

  it("counts each key on its own, and a refused request is not counted", async () => {
    let now = 0;
    const rl = createMemoryRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect((await rl.hit("a")).ok).toBe(true);
    expect((await rl.hit("b")).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect((await rl.hit("a")).ok).toBe(false);
    now = 1001; // only the first accepted hit counted, so one slot is free again
    expect((await rl.hit("a")).ok).toBe(true);
  });

  it("keeps memory bounded", async () => {
    const rl = createMemoryRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: () => 0 });
    await rl.hit("a");
    await rl.hit("b");
    await rl.hit("c"); // evicts "a"
    expect((await rl.hit("a")).ok).toBe(true);
  });

  it("rejects a nonsense configuration", () => {
    expect(() => createMemoryRateLimiter({ limit: 0, windowMs: 1000 })).toThrow();
    expect(() => createMemoryRateLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});

describe("createRedisRateLimiter (fake Redis: parsing and failure policy; the script itself runs in the integration test)", () => {
  const fake = (reply: unknown | Error): RedisLike & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      async eval(...args) {
        calls.push(args);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
  };

  it("sends the script, one key (prefixed), the window, the limit and a unique member", async () => {
    const redis = fake([1, 14]);
    const rl = createRedisRateLimiter({ redis, limit: 15, windowMs: 60_000, prefix: "p:" });
    expect(await rl.hit("likes:1.2.3.4")).toEqual({ ok: true, remaining: 14 });
    await rl.hit("likes:1.2.3.4");
    const [script, numKeys, key, windowMs, limit, member] = redis.calls[0]!;
    expect(script).toBe(SLIDING_WINDOW_SCRIPT);
    expect([numKeys, key, windowMs, limit]).toEqual([1, "p:likes:1.2.3.4", 60_000, 15]);
    expect(member).not.toBe(redis.calls[1]![5]);
  });

  it("turns a refusal's milliseconds into whole seconds, at least one", async () => {
    expect(await createRedisRateLimiter({ redis: fake([0, 1500]), limit: 1, windowMs: 1 }).hit("k")).toEqual({
      ok: false,
      retryAfterSeconds: 2,
    });
    expect(await createRedisRateLimiter({ redis: fake([0, 1]), limit: 1, windowMs: 1 }).hit("k")).toEqual({
      ok: false,
      retryAfterSeconds: 1,
    });
  });

  it("allows the request when Redis fails (default) and reports the error", async () => {
    const errors: unknown[] = [];
    const rl = createRedisRateLimiter({
      redis: fake(new Error("down")),
      limit: 1,
      windowMs: 1000,
      onError: (e) => errors.push(e),
    });
    expect((await rl.hit("k")).ok).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it("refuses the request when Redis fails and failOpen is false", async () => {
    const rl = createRedisRateLimiter({ redis: fake(new Error("down")), limit: 1, windowMs: 1000, failOpen: false });
    expect((await rl.hit("k")).ok).toBe(false);
  });

  it("treats a malformed reply as a failure, not as permission", async () => {
    const rl = createRedisRateLimiter({ redis: fake("OK"), limit: 1, windowMs: 1000, failOpen: false });
    expect((await rl.hit("k")).ok).toBe(false);
  });
});
