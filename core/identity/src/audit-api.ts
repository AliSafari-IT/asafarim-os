/**
 * Identity's trail for the Admin console (admin.asafarim.site): who signed in, who failed, who asked for
 * access and who decided. Read-only JSON, local sign-in only.
 *
 *   GET /admin/v1/audit[?event=&method=&principal=&handle=&since=&until=&before=&limit=]   newest first;
 *       event: up to 16 comma-separated events (`login.granted`) or kinds (`otp.`, every event starting with it)
 *   GET /admin/v1/audit/summary[?days=14]   counts per day and event, open requests, active connections
 *
 * Who may read it: the console passes the signed-in person's ID token as `Bearer`, as it does to core-api.
 * Identity checks the token is its own (signature, issuer, ES256), issued to a reader client
 * (IDENTITY_AUDIT_READERS, by default `core-admin`) and not expired, and then that the person is an
 * identity admin with an active connection, read fresh from the database. The console has already checked
 * core.admin with core-api, so a reader needs both. A refusal of a signed-in person is itself audited
 * (`admin.denied`, `detail.via = "audit_api"`).
 *
 * What it returns: the rows as stored (codes, counts and ids; never a code, a number or a token), with each
 * principal's label (its email, else its phone) for the admin to recognise them. Handles are HMACs: they let
 * an admin group attempts from one address, or on one identifier, without ever revealing either.
 */
import { createLocalJWKSet, jwtVerify, type JWK, type JWTVerifyGetKey } from "jose";
import type { HttpContext } from "./http.ts";
import { queryValue } from "./http.ts";
import type { Logger } from "./log.ts";
import type { AuditCounts, AuditEntry, AuditSearch, AuditSearchRow, Principal } from "./store.ts";
import { isUuid } from "./store.ts";

/** The slice of the store the API reads (PgIdentityStore; a fake in tests). */
export interface AuditReader {
  principal(id: string): Promise<Principal | null>;
  searchAudit(f: AuditSearch): Promise<{ events: AuditSearchRow[]; next: number | null }>;
  auditCounts(since: Date): Promise<AuditCounts>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface AuditApiDeps {
  issuer: string;
  /** IDENTITY_OIDC_JWKS: the private signing keys; only their public halves are used here. */
  jwks: { keys: JWK[] };
  /** The OIDC clients whose ID tokens may read the trail. */
  readers: readonly string[];
  store: AuditReader;
  log: Logger;
  /** Tests only. */
  now?: () => Date;
}

export interface AuditApi {
  /** Handles /admin/v1/audit and /admin/v1/audit/summary; false for any other path. */
  handle(ctx: HttpContext): Promise<boolean>;
}

const EVENT = /^[a-z][a-z_]*(?:\.[a-z_]*)?$/;
const METHOD = /^[a-z]{2,16}$/;
const HANDLE = /^[A-Za-z0-9_-]{8,128}$/;
const DATE = /^\d{4}-\d\d-\d\d/;
const DAY_MS = 86_400_000;

class Refused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The public half of a private EC JWK. */
function publicJwk({ kty, crv, x, y, kid }: JWK): JWK {
  return { kty, crv, x, y, kid, alg: "ES256", use: "sig" } as JWK;
}

export function createAuditApi(d: AuditApiDeps): AuditApi {
  const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: d.jwks.keys.map(publicJwk) });
  const now = d.now ?? (() => new Date());

  async function reader(ctx: HttpContext): Promise<Principal> {
    const bearer = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(ctx.get("authorization"))?.[1];
    if (!bearer) throw new Refused(401, "unauthorized", "send the ID token as a Bearer token");
    let sub: string;
    try {
      const { payload } = await jwtVerify(bearer, keys, {
        issuer: d.issuer,
        audience: [...d.readers],
        algorithms: ["ES256"],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== "string") throw new Error("no sub");
      sub = payload.sub;
    } catch (err) {
      d.log.warn("audit_api.token_refused", { errorCode: (err as Error).name });
      throw new Refused(401, "unauthorized", "the ID token isn't valid: sign in again");
    }
    const principal = isUuid(sub) ? await d.store.principal(sub) : null;
    if (!principal?.isAdmin || principal.connection !== "active") {
      if (principal) {
        await d.store
          .audit({ event: "admin.denied", principalId: principal.id, detail: { via: "audit_api" } })
          .catch(() => undefined);
      }
      throw new Refused(403, "forbidden", "only an identity admin may read the sign-in trail");
    }
    return principal;
  }

  function time(ctx: HttpContext, name: string): Date | undefined {
    const v = queryValue(ctx, name);
    if (!v) return undefined;
    const t = new Date(v);
    if (v.length > 40 || !DATE.test(v) || Number.isNaN(t.getTime()))
      throw new Refused(400, "bad_request", `${name} must be a date or time (ISO 8601)`);
    return t;
  }

  function whole(ctx: HttpContext, name: string, max: number): number | undefined {
    const v = queryValue(ctx, name);
    if (!v) return undefined;
    if (!/^\d{1,12}$/.test(v) || Number(v) > max) throw new Refused(400, "bad_request", `${name} must be 1 to ${max}`);
    return Number(v);
  }

  function matching(ctx: HttpContext, name: string, re: RegExp): string | undefined {
    const v = queryValue(ctx, name);
    if (!v) return undefined;
    if (!re.test(v)) throw new Refused(400, "bad_request", `${name} isn't valid`);
    return v;
  }

  async function search(ctx: HttpContext) {
    const principal = matching(ctx, "principal", /^[0-9a-f-]{36}$/i);
    if (principal && !isUuid(principal)) throw new Refused(400, "bad_request", "principal isn't valid");
    const f: AuditSearch = {};
    const event = queryValue(ctx, "event");
    const wanted = event ? event.split(",") : [];
    if (wanted.length > 16 || wanted.some((e) => !EVENT.test(e)))
      throw new Refused(400, "bad_request", "event isn't valid");
    const method = matching(ctx, "method", METHOD);
    const handle = matching(ctx, "handle", HANDLE);
    const since = time(ctx, "since");
    const until = time(ctx, "until");
    const before = whole(ctx, "before", 1e12);
    const limit = whole(ctx, "limit", 200);
    if (wanted.length) f.events = wanted;
    if (method) f.method = method;
    if (principal) f.principalId = principal.toLowerCase();
    if (handle) f.handle = handle;
    if (since) f.since = since;
    if (until) f.until = until;
    if (before) f.before = before;
    if (limit) f.limit = limit;
    const { events, next } = await d.store.searchAudit(f);
    return { events: events.map((e) => ({ ...e, at: e.at.toISOString() })), next };
  }

  async function summary(ctx: HttpContext) {
    const days = whole(ctx, "days", 90) || 14;
    const t = now();
    const today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    const since = new Date(today - (days - 1) * DAY_MS);
    const counts = await d.store.auditCounts(since);
    const byDay = Array.from({ length: days }, (_, i) => ({
      day: new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10),
      total: 0,
      events: {} as Record<string, number>,
    }));
    const index = new Map(byDay.map((x) => [x.day, x]));
    const byEvent: Record<string, number> = {};
    let total = 0;
    for (const r of counts.perDay) {
      const day = index.get(r.day);
      if (!day) continue;
      day.events[r.event] = (day.events[r.event] ?? 0) + r.n;
      day.total += r.n;
      byEvent[r.event] = (byEvent[r.event] ?? 0) + r.n;
      total += r.n;
    }
    return {
      days,
      since: since.toISOString(),
      total,
      byDay,
      byEvent,
      pendingRequests: counts.pendingRequests,
      activeConnections: counts.activeConnections,
    };
  }

  return {
    async handle(ctx) {
      const route =
        ctx.path === "/admin/v1/audit" ? search : ctx.path === "/admin/v1/audit/summary" ? summary : undefined;
      if (!route) return false;
      ctx.set("Cache-Control", "no-store");
      ctx.set("X-Content-Type-Options", "nosniff");
      try {
        if (ctx.method !== "GET") throw new Refused(405, "method_not_allowed", "GET only");
        await reader(ctx);
        ctx.status = 200;
        ctx.type = "json";
        ctx.body = await route(ctx);
      } catch (err) {
        if (!(err instanceof Refused)) d.log.error("audit_api.failed", { errorCode: (err as Error).name });
        const r = err instanceof Refused ? err : new Refused(500, "internal", "the trail can't be read right now");
        ctx.status = r.status;
        ctx.type = "json";
        ctx.body = { error: r.code, message: r.message };
      }
      return true;
    },
  };
}
