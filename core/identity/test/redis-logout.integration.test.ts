/** Revocation is committed for every browser before waiting for any RP delivery. Test Redis only. */
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { endSessionsOfAccount, redisAdapterFactory } from "../src/redis-adapter.ts";
const input = process.env.IDENTITY_TEST_REDIS_URL;
describe.skipIf(!input)("account-wide logout ordering", () => {
  let redis: Redis;
  beforeAll(async () => {
    const url = new URL(input!);
    url.pathname = "/12";
    redis = new Redis(url.href);
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis?.flushdb();
    await redis?.quit();
  });
  it("deletes every target session/token before invoking callbacks, even when delivery fails", async () => {
    const Adapter = redisAdapterFactory(redis);
    for (const [id, accountId] of [
      ["one", "target"],
      ["two", "target"],
      ["other", "other"],
    ]) {
      await new Adapter("Session").upsert(
        id!,
        { accountId, authorizations: { demo: { grantId: `grant-${id}`, sid: `sid-${id}` } } },
        60,
      );
      await new Adapter("AccessToken").upsert(`token-${id}`, { grantId: `grant-${id}` }, 60);
      await new Adapter("Grant").upsert(`grant-${id}`, {}, 60);
    }
    const notification = vi.fn(async () => {
      expect(
        await redis.exists(
          "oidc:Session:one",
          "oidc:Session:two",
          "oidc:AccessToken:token-one",
          "oidc:AccessToken:token-two",
        ),
      ).toBe(0);
      expect(await redis.exists("oidc:Session:other", "oidc:AccessToken:token-other")).toBe(2);
      throw new Error("delivery failed");
    });
    expect(await endSessionsOfAccount(redis, "target", notification)).toBe(2);
    expect(notification).toHaveBeenCalledTimes(2);
  });
});
