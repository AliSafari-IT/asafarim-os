/**
 * In-memory stand-ins for the SMS sign-in's storage and SMS sender, with the
 * same semantics as the Redis and Postgres implementations (which have their
 * own integration tests), plus a minimal Koa-like context for driving the
 * routes without a server.
 */
import { randomUUID } from "node:crypto";
import type { AuthSession, AuthSessions, LoginFlow, LoginFlows } from "../src/auth-session.ts";
import { newToken } from "../src/auth-session.ts";
import type { CookieOptions, HttpContext } from "../src/http.ts";
import type { Limit, LimitResult, OtpChallenges, RateLimiter, VerifyResult } from "../src/otp.ts";
import { OTP_MAX_ATTEMPTS } from "../src/otp.ts";
import type { SmsSender } from "../src/sms.ts";
import type {
  AuditEntry,
  AuditRow,
  ConnectionRequestRow,
  ConnectionRow,
  IdentityStore,
  Principal,
  RequestOutcome,
} from "../src/store.ts";

interface P {
  id: string;
  isAdmin: boolean;
  phone: string | null;
  verifiedAt: Date | null;
  lastLoginAt: Date | null;
}
interface C {
  status: "active" | "revoked";
  grantedAt: Date;
  revokedAt: Date | null;
}
interface R {
  id: string;
  principalId: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
}

export class MemoryStore implements IdentityStore {
  readonly principals = new Map<string, P>();
  readonly connectionsById = new Map<string, C>();
  readonly requests: R[] = [];
  readonly auditLog: AuditEntry[] = [];

  private byPhone(phone: string): P | undefined {
    return [...this.principals.values()].find((p) => p.phone === phone);
  }

  private ensure(phone: string): P {
    let p = this.byPhone(phone);
    if (!p) {
      p = { id: randomUUID(), isAdmin: false, phone, verifiedAt: null, lastLoginAt: null };
      this.principals.set(p.id, p);
    }
    return p;
  }

  private grant(id: string) {
    const c = this.connectionsById.get(id);
    if (c?.status === "active") return;
    this.connectionsById.set(id, { status: "active", grantedAt: new Date(), revokedAt: null });
  }

  async verifiedPhoneLogin(phone: string) {
    const p = this.ensure(phone);
    p.verifiedAt ??= new Date();
    p.lastLoginAt = new Date();
    return p.id;
  }

  async principal(id: string): Promise<Principal | null> {
    const p = this.principals.get(id);
    if (!p) return null;
    return { id: p.id, isAdmin: p.isAdmin, phone: p.phone, connection: this.connectionsById.get(id)?.status ?? "none" };
  }

  async requestConnection(principalId: string): Promise<RequestOutcome> {
    if (this.connectionsById.get(principalId)?.status === "active") return "already_connected";
    if (this.requests.some((r) => r.principalId === principalId && r.status === "pending")) return "already_pending";
    this.requests.push({ id: randomUUID(), principalId, status: "pending", createdAt: new Date() });
    return "created";
  }

  async hasPendingRequest(principalId: string) {
    return this.requests.some((r) => r.principalId === principalId && r.status === "pending");
  }

  async pendingRequests(): Promise<ConnectionRequestRow[]> {
    return this.requests
      .filter((r) => r.status === "pending")
      .map((r) => ({
        id: r.id,
        principalId: r.principalId,
        phone: this.principals.get(r.principalId)?.phone ?? null,
        createdAt: r.createdAt,
      }));
  }

  async connections(): Promise<ConnectionRow[]> {
    return [...this.connectionsById].map(([id, c]) => {
      const p = this.principals.get(id)!;
      return {
        principalId: id,
        phone: p.phone,
        status: c.status,
        isAdmin: p.isAdmin,
        grantedAt: c.grantedAt,
        revokedAt: c.revokedAt,
        lastLoginAt: p.lastLoginAt,
      };
    });
  }

  async decideRequest(requestId: string, decision: "approved" | "rejected", actorId: string) {
    const r = this.requests.find((x) => x.id === requestId && x.status === "pending");
    if (!r) return null;
    r.status = decision;
    if (decision === "approved") this.grant(r.principalId);
    this.auditLog.push({
      event: decision === "approved" ? "request.approved" : "request.rejected",
      principalId: r.principalId,
      actorId,
    });
    return r.principalId;
  }

  async revoke(principalId: string, actorId: string) {
    const c = this.connectionsById.get(principalId);
    if (c?.status !== "active") return false;
    c.status = "revoked";
    c.revokedAt = new Date();
    this.auditLog.push({ event: "connection.revoked", principalId, actorId });
    return true;
  }

  async addConnection(phone: string, actorId: string) {
    const p = this.ensure(phone);
    this.grant(p.id);
    for (const r of this.requests) if (r.principalId === p.id && r.status === "pending") r.status = "approved";
    this.auditLog.push({ event: "connection.added", principalId: p.id, actorId });
    return p.id;
  }

  async bootstrapAdmin(phone: string) {
    const hasAdmin = [...this.principals.values()].some(
      (p) => p.isAdmin && this.connectionsById.get(p.id)?.status === "active",
    );
    if (hasAdmin) return "unchanged" as const;
    const p = this.ensure(phone);
    p.isAdmin = true;
    this.grant(p.id);
    this.auditLog.push({ event: "connection.bootstrapped", principalId: p.id });
    return "bootstrapped" as const;
  }

  async audit(entry: AuditEntry) {
    this.auditLog.push(entry);
  }

  async recentAudit(limit: number): Promise<AuditRow[]> {
    return this.auditLog
      .slice(-limit)
      .reverse()
      .map((e) => ({
        at: new Date(),
        event: e.event,
        principalId: e.principalId ?? null,
        actorId: e.actorId ?? null,
        phone: e.principalId ? (this.principals.get(e.principalId)?.phone ?? null) : null,
        detail: e.detail ?? {},
      }));
  }

  events(): string[] {
    return this.auditLog.map((e) => e.event);
  }

  async ping() {}
  async close() {}
}

export class MemoryChallenges implements OtpChallenges {
  readonly rows = new Map<string, { hash: string; attempts: number }>();

  async create(challengeId: string, codeHash: string) {
    if (!this.rows.has(challengeId)) this.rows.set(challengeId, { hash: codeHash, attempts: 0 });
  }

  async verify(challengeId: string, codeHash: string): Promise<VerifyResult> {
    const c = this.rows.get(challengeId);
    if (!c) return "missing";
    if (c.hash === codeHash) {
      this.rows.delete(challengeId);
      return "ok";
    }
    c.attempts += 1;
    if (c.attempts >= OTP_MAX_ATTEMPTS) {
      this.rows.delete(challengeId);
      return "exhausted";
    }
    return "wrong";
  }
}

export class MemoryLimiter implements RateLimiter {
  readonly counts = new Map<string, number>();
  readonly cooldowns = new Set<string>();
  readonly keys: string[] = [];

  async hit(bucket: string, id: string, limit: Limit): Promise<LimitResult> {
    const key = `${bucket}:${id}`;
    this.keys.push(key);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { allowed: n <= limit.max, retryAfter: limit.windowSeconds };
  }

  async cooldown(bucket: string, id: string) {
    const key = `${bucket}:${id}`;
    this.keys.push(key);
    if (this.cooldowns.has(key)) return false;
    this.cooldowns.add(key);
    return true;
  }

  reset() {
    this.counts.clear();
    this.cooldowns.clear();
  }
}

export class MemorySessions implements AuthSessions {
  readonly rows = new Map<string, AuthSession>();

  async create(principalId: string) {
    const token = newToken();
    const session = { principalId, csrf: newToken(), authTime: Math.floor(Date.now() / 1000) };
    this.rows.set(token, session);
    return { token, session };
  }

  async get(token: string) {
    return this.rows.get(token) ?? null;
  }

  async destroy(token: string) {
    this.rows.delete(token);
  }

  async destroyAllFor(principalId: string) {
    for (const [t, s] of this.rows) if (s.principalId === principalId) this.rows.delete(t);
  }
}

export class MemoryFlows implements LoginFlows {
  readonly rows = new Map<string, LoginFlow>();

  async create(flow: LoginFlow) {
    const token = newToken();
    this.rows.set(token, flow);
    return token;
  }

  async get(token: string) {
    return this.rows.get(token) ?? null;
  }

  async update(token: string, flow: LoginFlow) {
    if (this.rows.has(token)) this.rows.set(token, flow);
  }

  async destroy(token: string) {
    this.rows.delete(token);
  }
}

export class CapturingSender implements SmsSender {
  readonly sent: { to: string; body: string }[] = [];
  fail = false;

  async send(to: string, body: string) {
    if (this.fail) throw new Error("provider down");
    this.sent.push({ to, body });
  }

  /** The code in the last SMS to `to`. */
  lastCode(to: string): string {
    const msg = [...this.sent].reverse().find((m) => m.to === to);
    const m = msg && /code is (\d{6})/.exec(msg.body);
    if (!m) throw new Error(`no code was sent to ${to}`);
    return m[1]!;
  }
}

/** A browser: cookies by name (paths ignored), like the integration tests' jar. */
export class Browser {
  readonly cookies = new Map<string, string>();
  ip = "203.0.113.7";
}

export interface Reply {
  status: number;
  location: string | undefined;
  body: string;
  headers: Record<string, string>;
}

/** Runs one request through `handler` with a context built for `browser`. */
export async function request(
  handler: (ctx: HttpContext) => Promise<boolean | void>,
  browser: Browser,
  method: "GET" | "POST",
  url: string,
  form?: Record<string, string>,
): Promise<Reply & { handled: boolean | void }> {
  const u = new URL(url, "https://id.example.test");
  const headers: Record<string, string> = {};
  const body = form ? new URLSearchParams(form).toString() : "";
  const ctx: HttpContext & { location?: string } = {
    method,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    ip: browser.ip,
    ips: [],
    secure: true,
    status: 404,
    type: "",
    body: undefined,
    req: (async function* () {
      if (body) yield Buffer.from(body);
    })(),
    cookies: {
      get: (name: string) => browser.cookies.get(name),
      set: (name: string, value?: string | null, _opts?: CookieOptions) => {
        if (value) browser.cookies.set(name, value);
        else browser.cookies.delete(name);
      },
    },
    is: (type: string) => (form && type === "application/x-www-form-urlencoded" ? type : false),
    set: (field: string, value: string) => {
      headers[field.toLowerCase()] = value;
    },
    redirect(url: string) {
      this.location = url;
      this.status = 302;
    },
  };
  const handled = await handler(ctx);
  return {
    handled,
    status: ctx.status,
    location: ctx.location,
    body: typeof ctx.body === "string" ? ctx.body : "",
    headers,
  };
}

/** The CSRF token in a page's forms. */
export function csrfOf(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("no csrf field on the page");
  return m[1]!;
}
