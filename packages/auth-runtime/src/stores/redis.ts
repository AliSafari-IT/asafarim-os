/**
 * The reference store over Redis. Every operation that must be atomic is one Lua script, so two processes can never
 * both win a refresh lock, read a session across a logout, or save a refresh result without the lock.
 *
 * Keys never contain a raw session id, `sid`, `sub` or `jti`: they are HMAC-SHA-256 digests under a key derived from
 * `secret`, so a Redis dump or a `KEYS *` does not hand out working cookie values. Session records are encrypted
 * (AES-256-GCM, authenticated with their own key digest, so a record moved to another key fails) because they hold
 * tokens. The client is injected and only needs `eval` (ioredis fits).
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { InvalidConfigError, StoreCorruptError } from "../errors.js";
import type {
  Flow,
  FlowStore,
  LockToken,
  LogoutRecord,
  SessionStore,
  StoredSession,
  StoreReadResult,
} from "../types.js";

export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisStoreOptions {
  redis: RedisLike;
  /** At least 32 bytes of secret (base64url or hex string, or bytes). Server-side only; never in the browser. */
  secret: string | Uint8Array;
  /** Key prefix, which also separates apps sharing one Redis. Default `auth`. */
  prefix?: string;
}

const READ = `
local h = redis.call('HMGET', KEYS[1], 'rec', 'sidh', 'subh', 'iat', 'seen', 'exp')
if not h[1] then return {'missing'} end
local now = tonumber(ARGV[1])
if now >= tonumber(h[6]) then redis.call('DEL', KEYS[1]); return {'expired'} end
local since = tonumber(h[4])
if h[2] ~= '' then
  local m = redis.call('GET', ARGV[4] .. 's:' .. h[2])
  if m and tonumber(m) >= since then redis.call('DEL', KEYS[1]); return {'revoked'} end
end
local m2 = redis.call('GET', ARGV[4] .. 'u:' .. h[3])
if m2 and tonumber(m2) >= since then redis.call('DEL', KEYS[1]); return {'revoked'} end
local idle = tonumber(ARGV[2])
if idle > 0 and now - tonumber(h[5]) >= idle then redis.call('DEL', KEYS[1]); return {'idle'} end
if ARGV[3] == '1' then redis.call('HSET', KEYS[1], 'seen', ARGV[1]) end
return {'ok', h[1], h[2], h[3]}
`;

// ARGV: rec, sidh, subh, iat(seconds), seen, exp, ttlMs, markerPrefix
const CREATE = `
local since = tonumber(ARGV[4])
if ARGV[2] ~= '' then
  local m = redis.call('GET', ARGV[8] .. 's:' .. ARGV[2])
  if m and tonumber(m) >= since then return 0 end
end
local m2 = redis.call('GET', ARGV[8] .. 'u:' .. ARGV[3])
if m2 and tonumber(m2) >= since then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'rec', ARGV[1], 'sidh', ARGV[2], 'subh', ARGV[3], 'iat', ARGV[4], 'seen', ARGV[5], 'exp', ARGV[6])
redis.call('PEXPIRE', KEYS[1], ARGV[7])
return 1
`;

// KEYS: session, lock. ARGV: lockToken, rec, markerPrefix
const UPDATE = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local h = redis.call('HMGET', KEYS[1], 'sidh', 'subh', 'iat')
if not h[3] then return 0 end
local since = tonumber(h[3])
if h[1] ~= '' then
  local m = redis.call('GET', ARGV[3] .. 's:' .. h[1])
  if m and tonumber(m) >= since then redis.call('DEL', KEYS[1]); return 0 end
end
local m2 = redis.call('GET', ARGV[3] .. 'u:' .. h[2])
if m2 and tonumber(m2) >= since then redis.call('DEL', KEYS[1]); return 0 end
redis.call('HSET', KEYS[1], 'rec', ARGV[2])
return 1
`;

const DESTROY = `redis.call('DEL', KEYS[1]); redis.call('DEL', KEYS[2]); return 1`;
const ACQUIRE = `if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end`;
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

// KEYS: jti. ARGV: ttlMs, iat, sidKey ('' if none), subKey ('' if none)
const LOGOUT = `
if not redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return 0 end
for i = 3, 4 do
  local k = ARGV[i]
  if k ~= '' then
    local cur = redis.call('GET', k)
    if (not cur) or tonumber(cur) < tonumber(ARGV[2]) then redis.call('SET', k, ARGV[2], 'PX', ARGV[1]) end
  end
end
return 1
`;

const TAKE = `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`;

function toBytes(secret: string | Uint8Array): Uint8Array {
  if (typeof secret !== "string") return secret;
  if (/^[0-9a-fA-F]{64,}$/.test(secret)) return Buffer.from(secret, "hex");
  return Buffer.from(secret, "base64url");
}

export function createRedisStore(o: RedisStoreOptions): SessionStore & FlowStore {
  const secret = toBytes(o.secret);
  if (secret.length < 32) throw new InvalidConfigError("the Redis store secret must be at least 32 bytes");
  const prefix = o.prefix ?? "auth";
  if (!/^[A-Za-z0-9:_-]+$/.test(prefix)) throw new InvalidConfigError("invalid Redis key prefix");
  const macKey = Buffer.from(hkdfSync("sha256", secret, "", "asafarim-auth-runtime/key-digest", 32));
  const encKey = Buffer.from(hkdfSync("sha256", secret, "", "asafarim-auth-runtime/record-encryption", 32));
  const { redis } = o;

  const digest = (kind: string, value: string): string =>
    createHmac("sha256", macKey).update(`${kind}\0${value}`).digest("base64url");
  const sessionKey = (id: string) => `${prefix}:s:${digest("session", id)}`;
  const lockKey = (id: string) => `${prefix}:l:${digest("session", id)}`;
  const flowKey = (id: string) => `${prefix}:f:${digest("flow", id)}`;
  const jtiKey = (jti: string) => `${prefix}:j:${digest("jti", jti)}`;
  const markerPrefix = `${prefix}:m:`;

  function seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", encKey, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
  }
  function open(blob: string, aad: string): string {
    try {
      const raw = Buffer.from(blob, "base64url");
      const d = createDecipheriv("aes-256-gcm", encKey, raw.subarray(0, 12));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    } catch {
      throw new StoreCorruptError();
    }
  }

  const metaOf = (s: StoredSession) => ({
    sidh: s.sid ? digest("sid", s.sid) : "",
    subh: digest("sub", s.identityKey.sub),
    since: Math.floor(s.issuedAt / 1000),
  });

  function parse(json: string, sidh: string, subh: string): StoredSession {
    let s: StoredSession;
    try {
      s = JSON.parse(json) as StoredSession;
    } catch {
      throw new StoreCorruptError();
    }
    // The plaintext metadata the scripts used for the logout checks must agree with the record itself.
    const m = metaOf(s);
    if (s?.version !== 1 || m.sidh !== sidh || m.subh !== subh) throw new StoreCorruptError();
    return s;
  }

  return {
    async get(id, { touch, idleMs, now }): Promise<StoreReadResult> {
      const key = sessionKey(id);
      const r = (await redis.eval(READ, 1, key, now, idleMs ?? 0, touch ? 1 : 0, markerPrefix)) as string[];
      const status = r[0];
      if (status === "ok") return { status, session: parse(open(r[1]!, key), r[2]!, r[3]!) };
      if (status === "missing" || status === "expired" || status === "idle" || status === "revoked") return { status };
      throw new StoreCorruptError();
    },
    async create(id, s, { now }) {
      const key = sessionKey(id);
      const m = metaOf(s);
      const ttl = Math.max(1000, s.expiresAt - now + 60_000);
      const ok = await redis.eval(
        CREATE,
        1,
        key,
        seal(JSON.stringify(s), key),
        m.sidh,
        m.subh,
        m.since,
        now,
        s.expiresAt,
        ttl,
        markerPrefix,
      );
      return ok === 1;
    },
    async update(id, s, lock) {
      const key = sessionKey(id);
      const ok = await redis.eval(UPDATE, 2, key, lockKey(id), lock.token, seal(JSON.stringify(s), key), markerPrefix);
      return ok === 1;
    },
    async destroy(id) {
      await redis.eval(DESTROY, 2, sessionKey(id), lockKey(id));
    },
    async acquireRefresh(id, leaseMs): Promise<LockToken | null> {
      const token = randomBytes(16).toString("base64url");
      const ok = await redis.eval(ACQUIRE, 1, lockKey(id), token, leaseMs);
      return ok === 1 ? { token } : null;
    },
    async renewRefresh(id, lock, leaseMs) {
      return (await redis.eval(RENEW, 1, lockKey(id), lock.token, leaseMs)) === 1;
    },
    async releaseRefresh(id, lock) {
      await redis.eval(RELEASE, 1, lockKey(id), lock.token);
    },
    async recordLogout(r: LogoutRecord) {
      const ok = await redis.eval(
        LOGOUT,
        1,
        jtiKey(r.jti),
        r.ttlMs,
        r.iat,
        r.sid ? `${markerPrefix}s:${digest("sid", r.sid)}` : "",
        r.sub ? `${markerPrefix}u:${digest("sub", r.sub)}` : "",
      );
      return ok === 1;
    },

    async put(id, flow: Flow, ttlMs) {
      const key = flowKey(id);
      await redis.eval(
        `redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]); return 1`,
        1,
        key,
        seal(JSON.stringify(flow), key),
        ttlMs,
      );
    },
    async take(id) {
      const key = flowKey(id);
      const v = (await redis.eval(TAKE, 1, key)) as string | null;
      if (!v) return null;
      try {
        return JSON.parse(open(v, key)) as Flow;
      } catch (err) {
        if (err instanceof StoreCorruptError) throw err;
        throw new StoreCorruptError();
      }
    },
  };
}
