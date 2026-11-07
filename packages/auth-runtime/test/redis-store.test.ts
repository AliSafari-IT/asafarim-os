/**
 * The Redis store against a REAL Redis (IDENTITY_TEST_REDIS_URL, as CI provides). Under CI a missing variable is a
 * failure, never a skip. Without CI it runs only when the variable is set.
 */
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StoreCorruptError, newId } from "../src/index.ts";
import { createRedisStore } from "../src/stores/redis.ts";
import { describeStoreContract, session } from "./store-contract.ts";

const URL_ = process.env.IDENTITY_TEST_REDIS_URL;
if (process.env.CI && !URL_) throw new Error("IDENTITY_TEST_REDIS_URL must be set in CI");

const secret = randomBytes(32).toString("base64url");
const prefix = `auth-rt-test-${randomBytes(4).toString("hex")}`;

if (!URL_) {
  describe("redis store (needs IDENTITY_TEST_REDIS_URL)", () => {
    it("is not configured here; CI sets it and fails without it", () => {
      expect(process.env.CI).toBeUndefined();
    });
  });
} else {
  const redis = new Redis(URL_);
  beforeAll(async () => {
    await redis.ping();
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });
  const make = () => createRedisStore({ redis, secret, prefix });

  describeStoreContract("real Redis: Redis store", async () => make());

  describe("real Redis: Redis store at rest", () => {
    it("keys hold no raw id, sid, sub or jti, and values hold no token", async () => {
      const store = make();
      const id = newId();
      const rec = session({
        sid: "plain-sid-value",
        identityKey: { iss: "https://id.example", sub: "plain-sub-value" },
      });
      await store.create(id, rec, { now: Date.now() });
      await store.recordLogout({ jti: "plain-jti-value", iat: 1, sid: "other-sid", sub: "other-sub", ttlMs: 60_000 });
      await store.put(
        newId(),
        {
          state: "s",
          nonce: "n",
          verifier: "plain-verifier-value".padEnd(43, "x"),
          returnTo: "/",
          fresh: false,
          createdAt: 1,
        },
        60_000,
      );
      const keys = await redis.keys(`${prefix}*`);
      expect(keys.length).toBeGreaterThanOrEqual(4);
      const dump: string[] = [...keys];
      for (const k of keys) {
        const type = await redis.type(k);
        if (type === "hash") dump.push(JSON.stringify(await redis.hgetall(k)));
        else if (type === "string") dump.push((await redis.get(k)) ?? "");
      }
      const text = dump.join("\n");
      for (const secretish of [
        id,
        "plain-sid-value",
        "plain-sub-value",
        "plain-jti-value",
        "other-sid",
        "other-sub",
        rec.accessToken,
        rec.refreshToken!,
        rec.csrf,
        "plain-verifier-value",
      ])
        expect(text, secretish).not.toContain(secretish);
    });

    it("a record copied under another key, a tampered record and a wrong secret all fail as corrupt, never as a session", async () => {
      const store = make();
      const [a, b] = [newId(), newId()];
      const ra = session({}, Date.now());
      const rb = session({}, Date.now());
      await store.create(a, ra, { now: Date.now() });
      await store.create(b, rb, { now: Date.now() });
      const keys = (await redis.keys(`${prefix}:s:*`)).sort();
      const [k1, k2] = [(await redis.hget(keys[0]!, "rec"))!, (await redis.hget(keys[1]!, "rec"))!];
      // Swap the two encrypted records: each key now holds the other's record.
      await redis.hset(keys[0]!, "rec", k2);
      await redis.hset(keys[1]!, "rec", k1);
      for (const id of [a, b])
        await expect(store.get(id, { touch: false, idleMs: null, now: Date.now() })).rejects.toBeInstanceOf(
          StoreCorruptError,
        );

      const c = newId();
      await store.create(c, session({}, Date.now()), { now: Date.now() });
      const ck = (await redis.keys(`${prefix}:s:*`)).find((k) => !keys.includes(k))!;
      const rec = (await redis.hget(ck, "rec"))!;
      await redis.hset(ck, "rec", rec.slice(0, -4) + (rec.endsWith("AAAA") ? "BBBB" : "AAAA"));
      await expect(store.get(c, { touch: false, idleMs: null, now: Date.now() })).rejects.toBeInstanceOf(
        StoreCorruptError,
      );

      const d = newId();
      await store.create(d, session({}, Date.now()), { now: Date.now() });
      const other = createRedisStore({ redis, secret: randomBytes(32).toString("base64url"), prefix });
      expect(await other.get(d, { touch: false, idleMs: null, now: Date.now() })).toEqual({ status: "missing" }); // different key digest: not even found
    });

    it("refuses a short secret and a bad prefix", () => {
      expect(() => createRedisStore({ redis, secret: "short" })).toThrow();
      expect(() => createRedisStore({ redis, secret, prefix: "bad prefix!" })).toThrow();
    });
  });
}
