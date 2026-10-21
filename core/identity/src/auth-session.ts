/**
 * Server-side state of the SMS sign-in, in Redis:
 *
 * - An **auth session** says "this browser proved principal P by a sign-in
 *   code". It is created only after a correct code, never from a phone
 *   number alone, and says nothing about authorization: that is read from the
 *   database on every use. The cookie holds a random token; Redis holds only
 *   its SHA-256. Revoking a connection deletes all of that principal's
 *   sessions at once.
 * - A **login flow** carries one browser through number → code: the CSRF
 *   token, where to go afterwards, and the pending challenge. Also keyed by
 *   the SHA-256 of a random cookie; it is deleted once the code is accepted.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import { KEY_PREFIX } from "./redis-adapter.ts";

/** The app SDK copies this as IDENTITY_SESSION_SECONDS; scripts/session-ttl.test.mjs keeps the two equal. */
export const AUTH_SESSION_TTL_SECONDS = 12 * 3600;
export const LOGIN_FLOW_TTL_SECONDS = 15 * 60;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

/** Constant-time string equality (for CSRF tokens). */
export function sameToken(a: string | undefined | null, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface AuthSession {
  principalId: string;
  /** Sent back in every form this session submits. */
  csrf: string;
  /** When the code was proved (epoch seconds): the OIDC `auth_time`. */
  authTime: number;
}

export interface AuthSessions {
  /** A new session for a principal who just proved a code; returns the cookie token. */
  create(principalId: string): Promise<{ token: string; session: AuthSession }>;
  get(token: string): Promise<AuthSession | null>;
  destroy(token: string): Promise<void>;
  /** Every session of this principal, everywhere (on revocation). */
  destroyAllFor(principalId: string): Promise<void>;
}

/** Where the person goes once signed in. */
export type LoginTarget = { kind: "interaction"; uid: string } | { kind: "home" } | { kind: "admin" };

export interface LoginFlow {
  csrf: string;
  target: LoginTarget;
  /** Set once a code was sent: how, where to (an E.164 number or an email address), and its challenge. */
  via?: "email" | "sms";
  identifier?: string;
  challengeId?: string;
}

/** Short-lived, single-use values (passkey challenges): stored, then taken exactly once. */
export interface Ephemeral {
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Returns and deletes the value in one step; null if it's gone or was never there. */
  take(key: string): Promise<string | null>;
}

export class RedisEphemeral implements Ephemeral {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  private key(key: string) {
    return `${KEY_PREFIX}once:${sha256(key)}`;
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key(key), value, "EX", ttlSeconds);
  }

  async take(key: string): Promise<string | null> {
    return this.client.getdel(this.key(key));
  }
}

export interface LoginFlows {
  create(flow: LoginFlow): Promise<string>;
  get(token: string): Promise<LoginFlow | null>;
  update(token: string, flow: LoginFlow): Promise<void>;
  destroy(token: string): Promise<void>;
}

export class RedisAuthSessions implements AuthSessions {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  private key(hash: string) {
    return `${KEY_PREFIX}sms-session:${hash}`;
  }

  private indexKey(principalId: string) {
    return `${KEY_PREFIX}sms-sessions-of:${principalId}`;
  }

  async create(principalId: string) {
    const token = newToken();
    const hash = sha256(token);
    const session: AuthSession = { principalId, csrf: newToken(), authTime: Math.floor(Date.now() / 1000) };
    await this.client
      .multi()
      .set(this.key(hash), JSON.stringify(session), "EX", AUTH_SESSION_TTL_SECONDS)
      .sadd(this.indexKey(principalId), hash)
      .expire(this.indexKey(principalId), AUTH_SESSION_TTL_SECONDS)
      .exec();
    return { token, session };
  }

  async get(token: string): Promise<AuthSession | null> {
    if (!token || token.length > 128) return null;
    const raw = await this.client.get(this.key(sha256(token)));
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as AuthSession;
      return typeof s.principalId === "string" && typeof s.csrf === "string" && typeof s.authTime === "number"
        ? s
        : null;
    } catch {
      return null;
    }
  }

  async destroy(token: string): Promise<void> {
    const hash = sha256(token);
    const session = await this.get(token);
    const tx = this.client.multi().del(this.key(hash));
    if (session) tx.srem(this.indexKey(session.principalId), hash);
    await tx.exec();
  }

  async destroyAllFor(principalId: string): Promise<void> {
    const hashes = await this.client.smembers(this.indexKey(principalId));
    const tx = this.client.multi();
    for (const h of hashes) tx.del(this.key(h));
    tx.del(this.indexKey(principalId));
    await tx.exec();
  }
}

export class RedisLoginFlows implements LoginFlows {
  private readonly client: Redis;

  constructor(client: Redis) {
    this.client = client;
  }

  private key(token: string) {
    return `${KEY_PREFIX}sms-flow:${sha256(token)}`;
  }

  async create(flow: LoginFlow): Promise<string> {
    const token = newToken();
    await this.client.set(this.key(token), JSON.stringify(flow), "EX", LOGIN_FLOW_TTL_SECONDS);
    return token;
  }

  async get(token: string): Promise<LoginFlow | null> {
    if (!token || token.length > 128) return null;
    const raw = await this.client.get(this.key(token));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LoginFlow;
    } catch {
      return null;
    }
  }

  async update(token: string, flow: LoginFlow): Promise<void> {
    // Keep the flow's original deadline: a flow can't be stretched by resending codes.
    await this.client.set(this.key(token), JSON.stringify(flow), "KEEPTTL", "XX");
  }

  async destroy(token: string): Promise<void> {
    await this.client.del(this.key(token));
  }
}
