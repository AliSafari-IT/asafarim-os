/**
 * oidc-provider storage in Redis (ADR 0002, A4): sessions, interactions,
 * grants, codes and tokens under the `oidc:` prefix in a dedicated logical DB
 * (select it in IDENTITY_REDIS_URL, e.g. redis://redis:6379/3). Every key gets
 * the model's TTL from oidc-provider. Losing Redis means users sign in again.
 */
import type { Redis } from "ioredis";
import type { ReplayGuard } from "./handoff.ts";

export const KEY_PREFIX = "oidc:";

/** Models whose records are revoked together when their grant is (grantId index). */
const GRANTABLE = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

/** Models stored as JSON strings rather than hashes. */
const CONSUMABLE = new Set(["AuthorizationCode", "RefreshToken", "DeviceCode", "BackchannelAuthenticationRequest"]);

type Payload = Record<string, unknown> & { grantId?: string; userCode?: string; uid?: string; consumed?: number };

const grantKey = (id: string) => `${KEY_PREFIX}grant:${id}`;
const userCodeKey = (code: string) => `${KEY_PREFIX}userCode:${code}`;
const uidKey = (uid: string) => `${KEY_PREFIX}uid:${uid}`;

export function redisAdapterFactory(client: Redis) {
  return class RedisAdapter {
    readonly name: string;

    constructor(name: string) {
      this.name = name;
    }

    key(id: string): string {
      return `${KEY_PREFIX}${this.name}:${id}`;
    }

    async upsert(id: string, payload: Payload, expiresIn: number): Promise<void> {
      const key = this.key(id);
      const multi = client.multi();
      if (CONSUMABLE.has(this.name)) {
        multi.call("HSET", key, "payload", JSON.stringify(payload));
      } else {
        multi.set(key, JSON.stringify(payload));
      }
      if (expiresIn) multi.expire(key, expiresIn);

      if (GRANTABLE.has(this.name) && payload.grantId) {
        const gk = grantKey(payload.grantId);
        multi.rpush(gk, key);
        // The grant index lives at least as long as its longest member.
        const ttl = await client.ttl(gk);
        if (expiresIn > ttl) multi.expire(gk, expiresIn);
      }
      if (payload.userCode) {
        multi.set(userCodeKey(payload.userCode), id);
        if (expiresIn) multi.expire(userCodeKey(payload.userCode), expiresIn);
      }
      if (payload.uid) {
        multi.set(uidKey(payload.uid), id);
        if (expiresIn) multi.expire(uidKey(payload.uid), expiresIn);
      }
      await multi.exec();
    }

    async find(id: string): Promise<Payload | undefined> {
      const key = this.key(id);
      if (CONSUMABLE.has(this.name)) {
        const data = (await client.hgetall(key)) as Record<string, string>;
        if (!data || !data.payload) return undefined;
        const payload = JSON.parse(data.payload) as Payload;
        if (data.consumed) payload.consumed = Number(data.consumed);
        return payload;
      }
      const data = await client.get(key);
      return data ? (JSON.parse(data) as Payload) : undefined;
    }

    async findByUid(uid: string): Promise<Payload | undefined> {
      const id = await client.get(uidKey(uid));
      return id ? this.find(id) : undefined;
    }

    async findByUserCode(userCode: string): Promise<Payload | undefined> {
      const id = await client.get(userCodeKey(userCode));
      return id ? this.find(id) : undefined;
    }

    async destroy(id: string): Promise<void> {
      await client.del(this.key(id));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      const gk = grantKey(grantId);
      const keys = await client.lrange(gk, 0, -1);
      const multi = client.multi();
      for (const k of keys) multi.del(k);
      multi.del(gk);
      await multi.exec();
    }

    async consume(id: string): Promise<void> {
      await client.hset(this.key(id), "consumed", Math.floor(Date.now() / 1000));
    }
  };
}

/** Single-use hand-off assertions: SET NX with the token's remaining lifetime. */
export class RedisReplayGuard implements ReplayGuard {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  async claimOnce(jti: string, ttlSeconds: number): Promise<boolean> {
    const ok = await this.client.set(`${KEY_PREFIX}assertion-jti:${jti}`, "1", "EX", Math.max(1, ttlSeconds), "NX");
    return ok === "OK";
  }
}
