/**
 * Permission checks (P3.2, ADR 0001 §4). The app asks core-api, with a signed
 * GET, what a subject may do in THIS app: the roles an admin granted them and
 * the permissions those roles carry. Answers are cached for a short TTL (60 s
 * by default) and concurrent lookups for one subject share a request.
 *
 * Fails closed: if core-api can't be reached and there's no fresh answer,
 * `access()` throws `AccessUnavailableError` and `can()` is false. A stale
 * answer is never served.
 */
import { signRequest } from "@asafarim/registry-protocol";
import { createTokenVerifier } from "./token.ts";

export interface SubjectAccess {
  subject: string;
  /** The app's lifecycle state: installed | active | inactive. */
  state: string;
  roles: string[];
  permissions: string[];
}

/** Optional on every check: the person's access token cookie (see token.ts). */
export interface CheckOptions {
  token?: string;
}

export class AccessUnavailableError extends Error {
  constructor(reason: string) {
    super(`couldn't resolve permissions from core-api: ${reason}`);
    this.name = "AccessUnavailableError";
  }
}

/** Thrown by `require()`: names the permission that was missing. */
export class ForbiddenError extends Error {
  readonly permission: string;
  readonly status = 403;
  constructor(permission: string) {
    super(`forbidden: requires the permission "${permission}"`);
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

/**
 * `instanceof` isn't reliable across bundles: a framework can load this
 * package twice (Next.js builds the instrumentation hook and each route
 * separately), so check the error's name instead.
 */
export const isForbiddenError = (err: unknown): err is ForbiddenError =>
  err instanceof ForbiddenError || (err instanceof Error && err.name === "ForbiddenError");
export const isAccessUnavailableError = (err: unknown): err is AccessUnavailableError =>
  err instanceof AccessUnavailableError || (err instanceof Error && err.name === "AccessUnavailableError");

/** The shape of the signed-in session the SDK needs: `session.user.id` is the identity `sub`. */
export interface SessionLike {
  user?: { id?: string | null } | null;
}

export interface AccessOptions {
  appId: string;
  credential: string;
  coreApiUrl: string;
  /** Cache lifetime in ms. Default 60 000. */
  ttlMs?: number;
  /** Verifies the person's access token; default: against core-api's JWKS. */
  tokens?: ReturnType<typeof createTokenVerifier>;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createAccess(opts: AccessOptions) {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 60_000;
  const base = opts.coreApiUrl.replace(/\/$/, "");
  const cache = new Map<string, { at: number; value: SubjectAccess }>();
  const inflight = new Map<string, Promise<SubjectAccess>>();
  const tokens =
    opts.tokens ??
    createTokenVerifier({
      appId: opts.appId,
      coreApiUrl: opts.coreApiUrl,
      fetch: opts.fetch,
      now: opts.now && (() => new Date(now())),
    });

  /**
   * Ask core-api for a short-lived access token for a person this app has
   * signed in (signed POST). The result goes in a cookie (`accessCookie`):
   * the gateway and `can()` verify it locally. An inactive app gets none.
   */
  async function mintToken(subject: string): Promise<{ token: string; expiresIn: number }> {
    const path = `/registry/v1/apps/${encodeURIComponent(opts.appId)}/subjects/${encodeURIComponent(subject)}/token`;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: signRequest({ credential: opts.credential, method: "POST", path }),
        cache: "no-store",
      });
    } catch {
      throw new AccessUnavailableError("core-api is unreachable");
    }
    const json = (await res.json().catch(() => ({}))) as { token?: unknown; expiresIn?: unknown; error?: string };
    if (!res.ok) throw new AccessUnavailableError(json.error ?? `http ${res.status}`);
    if (typeof json.token !== "string" || typeof json.expiresIn !== "number") {
      throw new AccessUnavailableError("core-api sent a malformed token answer");
    }
    return { token: json.token, expiresIn: json.expiresIn };
  }

  async function fetchAccess(subject: string): Promise<SubjectAccess> {
    const path = `/registry/v1/apps/${encodeURIComponent(opts.appId)}/subjects/${encodeURIComponent(subject)}`;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: signRequest({ credential: opts.credential, method: "GET", path }),
        // Never let a framework's fetch cache (Next.js caches GETs in development) answer for core-api.
        cache: "no-store",
      });
    } catch {
      throw new AccessUnavailableError("core-api is unreachable");
    }
    const json = (await res.json().catch(() => ({}))) as Partial<SubjectAccess> & { error?: string };
    if (!res.ok) throw new AccessUnavailableError(json.error ?? `http ${res.status}`);
    // A success that isn't the contract is a broken core-api, not an empty grant: never cache it as an answer.
    if (typeof json.state !== "string" || !Array.isArray(json.roles) || !Array.isArray(json.permissions)) {
      throw new AccessUnavailableError("core-api sent a malformed answer");
    }
    return { subject, state: json.state, roles: json.roles, permissions: json.permissions };
  }

  /**
   * What `subject` may do here. With a valid access token for this person and
   * this app, the answer is the token's own (no call to core-api; the gateway
   * only lets an ACTIVE app's traffic through, so the state is "active"); with
   * none, or a bad one, it is core-api's answer from the cache.
   */
  async function access(subject: string, check: CheckOptions = {}): Promise<SubjectAccess> {
    const claims = await tokens.verify(check.token);
    if (claims && claims.sub === subject) {
      return { subject, state: "active", roles: claims.roles, permissions: claims.perms };
    }
    return lookup(subject);
  }

  /** What `subject` may do here, from core-api or the cache. */
  async function lookup(subject: string): Promise<SubjectAccess> {
    const hit = cache.get(subject);
    if (hit && now() - hit.at < ttl) return hit.value;
    let pending = inflight.get(subject);
    if (!pending) {
      pending = fetchAccess(subject)
        .then((value) => {
          cache.set(subject, { at: now(), value });
          return value;
        })
        .finally(() => inflight.delete(subject));
      inflight.set(subject, pending);
    }
    return pending;
  }

  const subjectOf = (session: SessionLike | null | undefined) => session?.user?.id ?? undefined;

  /** `can(session, "notes.write")`: false for no session, and false (never throws) if core-api is down. */
  async function can(
    session: SessionLike | null | undefined,
    permission: string,
    check: CheckOptions = {},
  ): Promise<boolean> {
    const subject = subjectOf(session);
    if (!subject) return false;
    try {
      return (await access(subject, check)).permissions.includes(permission);
    } catch {
      return false;
    }
  }

  /** Like `can`, but throws `ForbiddenError` naming the permission (an outage surfaces as `AccessUnavailableError`). */
  async function require(
    session: SessionLike | null | undefined,
    permission: string,
    check: CheckOptions = {},
  ): Promise<SubjectAccess> {
    const subject = subjectOf(session);
    if (!subject) throw new ForbiddenError(permission);
    const result = await access(subject, check);
    if (!result.permissions.includes(permission)) throw new ForbiddenError(permission);
    return result;
  }

  return { access, can, require, mintToken, clearCache: () => cache.clear() };
}

export type Access = ReturnType<typeof createAccess>;
