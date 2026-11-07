/**
 * The session runtime: transport-independent. It turns a validated sign-in into a server-side session, and every later
 * request (by session id) into one validity decision: absolute and idle bounds, logout markers, refresh with a lock and
 * lease, a bounded provider re-check, freshness for step-up, and app-owned authorization policies.
 *
 * Tokens live in the store and nowhere else. The browser holds only an opaque random id.
 */
import { timingSafeEqual } from "node:crypto";
import { isFresh, resolveBounds } from "./bounds.js";
import { ID_PATTERN, newId } from "./cookies.js";
import {
  AuthRuntimeError,
  AuthenticationRequiredError,
  IdentityUnavailableError,
  InvalidConfigError,
  InvalidStateError,
  LogoutReplayError,
  ProfileDeniedError,
  ProviderRejectedError,
  RateLimitedError,
  RefreshBusyError,
  RefreshOwnershipLostError,
  SessionExpiredError,
  type SessionExpiredReason,
  StepUpRequiredError,
  StoreUnavailableError,
  TokenValidationError,
  CsrfError,
} from "./errors.js";
import type { OidcClient } from "./oidc.js";
import { normalizeOrigin, validateReturnTarget } from "./return-target.js";
import type {
  Flow,
  FlowStore,
  LockToken,
  ProfileHooks,
  ResolvedBounds,
  RuntimeDeps,
  SessionBounds,
  SessionState,
  SessionStore,
  SessionView,
  SignInDecision,
  StoredSession,
  StoreReadResult,
  ValidatedClaims,
} from "./types.js";

export interface SessionRuntimeOptions<A = unknown> {
  oidc: OidcClient;
  store: SessionStore;
  flows: FlowStore;
  /** Required. There are no implicit defaults (see `defaultBounds` for an example to copy). */
  bounds: SessionBounds;
  hooks?: ProfileHooks<A>;
  /** Named authorization policies this app evaluates through `hooks.authorize`. Anything else is refused. */
  policies?: readonly string[];
  /** Hand the access token to `onSignIn` / `authorize`. Default false: hooks see claims only. */
  needsTokens?: boolean;
  /** The app's own origin, exactly. Relative return targets resolve against it. */
  origin: string;
  /** Further origins a return target may point to, exactly (for example the public site and the management site). */
  allowedReturnOrigins?: readonly string[];
  defaultReturnTo?: string;
  /** `ui_locales` values the app supports. A locale outside the list falls back to `defaultLocale`. */
  locales?: readonly string[];
  defaultLocale?: string;
  /**
   * Sign-in intents the app supports, each with the (app-chosen) authorization parameters it adds. The runtime does not
   * invent provider parameters. Example: `{ signin: {}, register: { screen_hint: "register" } }`.
   */
  intents?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Flow lifetime. Default 600 000. */
  flowTtlMs?: number;
  deps?: RuntimeDeps;
}

export interface StartInput {
  returnTo?: string;
  locale?: string;
  intent?: string;
  /** Ask for a recent sign-in: `prompt=login` and `max_age=<freshMs>`. */
  fresh?: boolean;
  /** SSO is the default (no prompt). `none` fails with `login_required` instead of showing a page. */
  prompt?: "none" | "login" | "consent";
}

export interface StartResult {
  /** The opaque id of the server-side flow; the adapter binds it to the browser with a cookie. */
  flowId: string;
  flowMaxAgeSec: number;
  /** Where to send the browser. */
  redirect: string;
}

export interface CallbackResult {
  sessionId: string;
  maxAgeSec: number;
  returnTo: string;
  locale?: string;
  intent?: string;
}

/** A valid session as the app sees it. Tokens are reachable only through `accessToken()`, so a stray JSON.stringify can't leak them. */
export interface SessionHandle {
  readonly view: SessionView;
  readonly csrf: string;
  readonly fresh: boolean;
  accessToken(): string;
}

export type LogoutLocalResult = { scope: "local" };
export type LogoutEverywhereResult = { scope: "provider"; redirect: string };

export interface SessionRuntime {
  readonly bounds: ResolvedBounds;
  start(input?: StartInput): Promise<StartResult>;
  callback(input: {
    query: string | URLSearchParams;
    flowId?: string;
    previousSessionId?: string;
  }): Promise<CallbackResult>;
  /** The valid session for this id, or null (none, ended, revoked). Throws only on outages (fail closed). */
  current(id: string | undefined, o?: { touch?: boolean }): Promise<SessionHandle | null>;
  /** The single validity decision, as a small answer for a header or a guard. Never extends the idle window by default. */
  state(id: string | undefined, o?: { touch?: boolean }): Promise<SessionState>;
  /** Guard a route or API. Throws a typed error unless the session is valid, authorized for `policy`, and (if asked) fresh. */
  require(id: string | undefined, o?: { policy?: string; fresh?: boolean }): Promise<SessionHandle>;
  /** Ends this app's session only. Never depends on the provider. */
  logoutLocal(id: string | undefined): Promise<LogoutLocalResult>;
  /** Ends this app's session, then returns the provider's end-session URL (sign out everywhere). */
  logoutEverywhere(
    id: string | undefined,
    o?: { postLogoutRedirectUri?: string | null },
  ): Promise<LogoutEverywhereResult>;
  /** Validate a signed back-channel logout token and revoke what it names. Throws typed errors; 400/429/503 are for the adapter. */
  backchannelLogout(token: string): Promise<void>;
  verifyCsrf(handle: SessionHandle, supplied: unknown): void;
}

type Resolved =
  { kind: "none" } | { kind: "ended"; reason: SessionExpiredReason } | { kind: "active"; session: StoredSession };

const SAFE_LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function createSessionRuntime<A = unknown>(opts: SessionRuntimeOptions<A>): SessionRuntime {
  const bounds = resolveBounds(opts.bounds);
  const origin = normalizeOrigin(opts.origin);
  const allowedReturnOrigins = (opts.allowedReturnOrigins ?? []).map(normalizeOrigin);
  const returnOpts = { origin, allowedOrigins: allowedReturnOrigins };
  const defaultReturnTo = validateReturnTarget(opts.defaultReturnTo ?? "/", returnOpts);
  const policies = new Set(opts.policies ?? []);
  if (policies.has("access")) throw new InvalidConfigError('"access" is reserved for the app-wide gate');
  const locales = new Set(opts.locales ?? []);
  for (const l of locales) if (!SAFE_LOCALE.test(l)) throw new InvalidConfigError("locales must be language tags");
  const defaultLocale = opts.defaultLocale;
  if (defaultLocale && locales.size > 0 && !locales.has(defaultLocale))
    throw new InvalidConfigError("defaultLocale must be listed");
  const intents = opts.intents ?? {};
  const flowTtlMs = opts.flowTtlMs ?? 600_000;
  const hooks = opts.hooks ?? {};
  const deps = opts.deps ?? {};
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { oidc } = opts;

  const log = (event: string, err?: unknown) =>
    deps.log?.({ event, ...(err instanceof AuthRuntimeError ? { code: err.code } : {}) });
  const audit = (event: string, detail: Record<string, string | number | boolean | undefined> = {}) =>
    deps.audit?.(event, detail);

  // Any failure of the store that is not already typed is an outage of the store: fail closed.
  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthRuntimeError) throw err;
      throw new StoreUnavailableError();
    }
  }
  const store: SessionStore = {
    get: (id, o) => guard(() => opts.store.get(id, o)),
    create: (id, s, o) => guard(() => opts.store.create(id, s, o)),
    update: (id, s, l, o) => guard(() => opts.store.update(id, s, l, o)),
    destroy: (id) => guard(() => opts.store.destroy(id)),
    acquireRefresh: (id, ms) => guard(() => opts.store.acquireRefresh(id, ms)),
    renewRefresh: (id, l, ms) => guard(() => opts.store.renewRefresh(id, l, ms)),
    releaseRefresh: (id, l) => guard(() => opts.store.releaseRefresh(id, l)),
    recordLogout: (r) => guard(() => opts.store.recordLogout(r)),
  };
  const flows: FlowStore = {
    put: (id, f, ttl) => guard(() => opts.flows.put(id, f, ttl)),
    take: (id) => guard(() => opts.flows.take(id)),
  };

  const view = (s: StoredSession): SessionView => ({
    identityKey: s.identityKey,
    ...(s.sid ? { sid: s.sid } : {}),
    authTime: s.authTime,
    issuedAt: Math.floor(s.issuedAt / 1000),
    ...(s.amr ? { amr: s.amr } : {}),
    ...(s.acr ? { acr: s.acr } : {}),
    ...(s.emailHint ? { emailHint: s.emailHint } : {}),
    ...(s.app !== undefined ? { app: s.app } : {}),
    ...(opts.needsTokens ? { tokens: { accessToken: s.accessToken } } : {}),
  });

  function handleOf(s: StoredSession): SessionHandle {
    const h = {
      view: view(s),
      csrf: s.csrf,
      fresh: isFresh(s.authTime, now(), bounds.freshMs),
      accessToken: () => s.accessToken,
    };
    // Methods are not enumerable by JSON.stringify; make the intent explicit for anyone logging the handle.
    Object.defineProperty(h, "accessToken", { enumerable: false });
    return h;
  }

  const validId = (id: string | undefined): id is string => typeof id === "string" && ID_PATTERN.test(id);

  // ---- sign-in -----------------------------------------------------------------------------------------------------

  async function start(input: StartInput = {}): Promise<StartResult> {
    let returnTo = defaultReturnTo;
    if (input.returnTo !== undefined) {
      try {
        returnTo = validateReturnTarget(input.returnTo, returnOpts);
      } catch {
        returnTo = defaultReturnTo; // an invalid target is dropped, never followed
      }
    }
    const locale = input.locale && locales.has(input.locale) ? input.locale : defaultLocale;
    const intent = input.intent !== undefined && Object.hasOwn(intents, input.intent) ? input.intent : undefined;
    const fresh = input.fresh === true;
    const { verifier, challenge } = await oidc.newPkce();
    const flow: Flow = {
      state: oidc.newState(),
      nonce: oidc.newNonce(),
      verifier,
      returnTo,
      ...(locale ? { locale } : {}),
      ...(intent ? { intent } : {}),
      fresh,
      createdAt: now(),
    };
    const redirect = await oidc.authorizationUrl({
      state: flow.state,
      nonce: flow.nonce,
      codeChallenge: challenge,
      // Always ask for auth_time; a fresh sign-in asks for a recent one.
      maxAge: Math.floor((fresh ? bounds.freshMs : bounds.absoluteMs) / 1000),
      ...(fresh ? { prompt: ["login"] as const } : input.prompt ? { prompt: [input.prompt] as const } : {}),
      ...(locale ? { uiLocales: locale } : {}),
      ...(intent ? { extra: intents[intent]! } : {}),
    });
    const flowId = newId();
    await flows.put(flowId, flow, flowTtlMs);
    return { flowId, flowMaxAgeSec: Math.ceil(flowTtlMs / 1000), redirect: redirect.href };
  }

  async function callback(input: {
    query: string | URLSearchParams;
    flowId?: string;
    previousSessionId?: string;
  }): Promise<CallbackResult> {
    // Login CSRF / replay: the flow must be one this browser started (its cookie) and it is spent by the first use.
    const flow = validId(input.flowId) ? await flows.take(input.flowId) : null;
    if (!flow) throw new InvalidStateError("missing_flow");
    if (now() - flow.createdAt > flowTtlMs) throw new InvalidStateError("expired_flow");

    const query = new URLSearchParams(typeof input.query === "string" ? input.query : input.query.toString());
    // Exact redirect URI plus the response parameters; nothing else from the request is carried over.
    const callbackUrl = new URL(oidc.redirectUri);
    for (const key of ["code", "state", "iss", "error", "error_description", "error_uri"]) {
      const values = query.getAll(key);
      if (values.length > 1) throw new InvalidStateError("bad_callback");
      if (values.length === 1) callbackUrl.searchParams.set(key, values[0]!);
    }

    const t = now();
    const identity = await oidc.exchange(callbackUrl, {
      state: flow.state,
      nonce: flow.nonce,
      verifier: flow.verifier,
      maxAge: Math.floor((flow.fresh ? bounds.freshMs : bounds.absoluteMs) / 1000),
    });
    // The claims are checked again here; the browser's `fresh` choice was only a request, never evidence.
    if (identity.authTime * 1000 > t + 5000 || identity.issuedAt * 1000 > t + 5000)
      throw new TokenValidationError("auth_time");
    if (flow.fresh && !isFresh(identity.authTime, t, bounds.freshMs)) throw new StepUpRequiredError();
    const expiresAt = identity.authTime * 1000 + bounds.absoluteMs;
    if (t >= expiresAt) throw new SessionExpiredError("absolute");

    const { accessToken, refreshToken, expiresIn, ...claims } = identity;
    const decision: SignInDecision<A> = hooks.onSignIn
      ? await hooks.onSignIn(claims as ValidatedClaims, opts.needsTokens ? { accessToken } : undefined)
      : { allow: true };
    if (!decision.allow) {
      audit("signin.denied", { reason: decision.reason });
      throw new ProfileDeniedError(decision.reason);
    }

    const session: StoredSession = {
      version: 1,
      identityKey: identity.identityKey,
      ...(identity.sid ? { sid: identity.sid } : {}),
      authTime: identity.authTime,
      issuedAt: t,
      expiresAt,
      ...(identity.amr ? { amr: identity.amr } : {}),
      ...(identity.acr ? { acr: identity.acr } : {}),
      ...(identity.emailHint ? { emailHint: identity.emailHint } : {}),
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      accessExpiresAt: t + expiresIn * 1000,
      lastCheckedAt: t,
      csrf: newId(),
      ...(decision.app !== undefined ? { app: decision.app } : {}),
    };
    // A new id for every sign-in (no session fixation); a previous session of this browser is ended.
    const sessionId = newId();
    if (!(await store.create(sessionId, session, { now: t }))) throw new SessionExpiredError("revoked");
    if (validId(input.previousSessionId)) await store.destroy(input.previousSessionId).catch(() => undefined);
    audit("signin.ok", { sub: identity.identityKey.sub });
    return {
      sessionId,
      maxAgeSec: Math.max(1, Math.floor((expiresAt - t) / 1000)),
      returnTo: flow.returnTo,
      ...(flow.locale ? { locale: flow.locale } : {}),
      ...(flow.intent ? { intent: flow.intent } : {}),
    };
  }

  // ---- the one validity decision -----------------------------------------------------------------------------------

  const ended = (reason: SessionExpiredReason): Resolved => ({ kind: "ended", reason });

  function readResult(r: StoreReadResult): Resolved {
    switch (r.status) {
      case "ok":
        return { kind: "active", session: r.session };
      case "missing":
        return { kind: "none" };
      case "expired":
        return ended("absolute");
      case "idle":
        return ended("idle");
      case "revoked":
        return ended("revoked");
    }
  }

  async function resolve(id: string | undefined, touch: boolean): Promise<Resolved> {
    if (!validId(id)) return { kind: "none" };
    const t0 = now();
    const read = readResult(await store.get(id, { touch, idleMs: bounds.idleMs, now: t0 }));
    if (read.kind !== "active") return read;
    let s = read.session;
    if (t0 >= s.expiresAt) {
      await store.destroy(id);
      return ended("absolute");
    }

    // 1. An expired (or nearly expired) access token is refreshed, under the lock.
    if (s.accessExpiresAt - bounds.refreshSkewMs <= t0) {
      if (!s.refreshToken) {
        // Without a refresh token the session cannot outlive its access token.
        await store.destroy(id);
        return ended("token_expired");
      }
      const refreshed = await refreshLocked(id);
      if (refreshed.kind !== "active") return refreshed;
      s = refreshed.session;
    }

    // 2. A positive provider check no older than `revalidateMs`. An outage here denies; it never grants and never destroys.
    if (now() - s.lastCheckedAt > bounds.revalidateMs) {
      try {
        await oidc.userinfo(s.accessToken, s.identityKey.sub);
      } catch (err) {
        if (err instanceof ProviderRejectedError) {
          await store.destroy(id);
          audit("session.revoked_by_provider", { sub: s.identityKey.sub });
          return ended("revoked");
        }
        if (err instanceof IdentityUnavailableError) log("identity.unavailable", err);
        throw err;
      }
      s = { ...s, lastCheckedAt: now() };
      await saveChecked(id, s);
    }

    // 3. The app's own account state, if it has any.
    if (hooks.revalidate) {
      const live = await hooks.revalidate(view(s));
      if (!live.active) {
        await store.destroy(id);
        return ended("revoked");
      }
    }
    return { kind: "active", session: s };
  }

  /** Record a successful provider check. Best effort: when another request holds the lock, it is saving something newer. */
  async function saveChecked(id: string, s: StoredSession): Promise<void> {
    let lock: LockToken | null = null;
    try {
      lock = await store.acquireRefresh(id, bounds.refreshLeaseMs);
      if (lock) await store.update(id, s, lock, { now: now() });
    } catch {
      /* the check itself passed; failing to remember it only costs one more check */
    } finally {
      if (lock) await store.releaseRefresh(id, lock).catch(() => undefined);
    }
  }

  const needsRefresh = (s: StoredSession) => s.accessExpiresAt - bounds.refreshSkewMs <= now();

  async function refreshLocked(id: string): Promise<Resolved> {
    let lock = await store.acquireRefresh(id, bounds.refreshLeaseMs);
    if (!lock) {
      // Someone else is refreshing. Wait for their result instead of spending the (rotating) refresh token twice.
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const r = readResult(await store.get(id, { touch: false, idleMs: bounds.idleMs, now: now() }));
        if (r.kind !== "active") return r;
        if (!needsRefresh(r.session)) return r;
        lock = await store.acquireRefresh(id, bounds.refreshLeaseMs);
        if (lock) break;
      }
      if (!lock) throw new RefreshBusyError();
    }
    const held = lock;
    const lease = { lost: false, stopped: false };
    const every = Math.max(10, Math.floor(bounds.refreshLeaseMs / 3));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = () => {
      timer = setTimeout(async () => {
        if (lease.stopped) return;
        try {
          if (!(await store.renewRefresh(id, held, bounds.refreshLeaseMs))) lease.lost = true;
        } catch {
          lease.lost = true;
        }
        if (!lease.stopped && !lease.lost) renew();
      }, every);
      timer.unref?.();
    };
    renew();
    try {
      // The lock is ours: look again, another request may have refreshed just before we got it.
      const again = readResult(await store.get(id, { touch: false, idleMs: bounds.idleMs, now: now() }));
      if (again.kind !== "active") return again;
      if (!needsRefresh(again.session)) return again;
      const s = again.session;
      if (!s.refreshToken) {
        await store.destroy(id);
        return ended("token_expired");
      }
      let tokens;
      try {
        tokens = await oidc.refresh(s.refreshToken, s.identityKey.sub);
      } catch (err) {
        if (err instanceof ProviderRejectedError) {
          await store.destroy(id);
          audit("session.refresh_rejected", { sub: s.identityKey.sub });
          return ended("refresh_failed");
        }
        throw err; // outage: the session stays, the request is denied
      }
      // Never save a result without the lock: the refresh token was rotated, and whoever holds the lock now owns the session.
      if (lease.lost) throw new RefreshOwnershipLostError();
      const t = now();
      const next: StoredSession = {
        ...s,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        accessExpiresAt: t + tokens.expiresIn * 1000,
        lastCheckedAt: t,
      };
      if (!(await store.update(id, next, held, { now: t }))) throw new RefreshOwnershipLostError();
      return { kind: "active", session: next };
    } finally {
      lease.stopped = true;
      if (timer) clearTimeout(timer);
      await store.releaseRefresh(id, held).catch(() => undefined);
    }
  }

  // ---- reading the session -----------------------------------------------------------------------------------------

  async function current(id: string | undefined, o: { touch?: boolean } = {}): Promise<SessionHandle | null> {
    const r = await resolve(id, o.touch ?? true);
    return r.kind === "active" ? handleOf(r.session) : null;
  }

  async function evaluate(s: StoredSession, policy: string): Promise<boolean> {
    if (!hooks.authorize) return policy === "access";
    return (await hooks.authorize(view(s), policy)) === true;
  }

  async function state(id: string | undefined, o: { touch?: boolean } = {}): Promise<SessionState> {
    const authorized: Record<string, boolean> = Object.fromEntries([...policies].map((p) => [p, false]));
    const r = await resolve(id, o.touch ?? false);
    if (r.kind !== "active") return { status: "anonymous", authorized, fresh: false };
    const s = r.session;
    // Same evaluation, on every call, as `require` uses: the header and the routes cannot disagree.
    const access = await evaluate(s, "access");
    if (access) for (const p of policies) authorized[p] = await evaluate(s, p);
    return {
      status: access ? "active" : "unauthorized",
      sub: s.identityKey.sub,
      ...(s.emailHint ? { displayHint: s.emailHint } : {}),
      authorized,
      fresh: isFresh(s.authTime, now(), bounds.freshMs),
    };
  }

  async function require(id: string | undefined, o: { policy?: string; fresh?: boolean } = {}): Promise<SessionHandle> {
    if (o.policy !== undefined && !policies.has(o.policy)) throw new InvalidConfigError("unknown policy");
    const r = await resolve(id, true);
    if (r.kind === "none") throw new AuthenticationRequiredError();
    if (r.kind === "ended") throw new SessionExpiredError(r.reason);
    const s = r.session;
    if (!(await evaluate(s, "access"))) throw new ProfileDeniedError("access");
    if (o.policy !== undefined && !(await evaluate(s, o.policy))) throw new ProfileDeniedError("policy");
    if (o.fresh && !isFresh(s.authTime, now(), bounds.freshMs)) throw new StepUpRequiredError();
    return handleOf(s);
  }

  // ---- sign-out ----------------------------------------------------------------------------------------------------

  async function logoutLocal(id: string | undefined): Promise<LogoutLocalResult> {
    if (validId(id)) await store.destroy(id);
    return { scope: "local" };
  }

  async function logoutEverywhere(
    id: string | undefined,
    o: { postLogoutRedirectUri?: string | null } = {},
  ): Promise<LogoutEverywhereResult> {
    // The local session goes first and unconditionally; the provider URL is best effort (it has a built-in fallback).
    await logoutLocal(id);
    return { scope: "provider", redirect: await oidc.endSessionUrl(o) };
  }

  async function backchannelLogout(token: string): Promise<void> {
    if (deps.budget && !(await deps.budget("backchannel-logout", "global"))) throw new RateLimitedError();
    const c = await oidc.validateLogoutToken(token);
    const fresh = await store.recordLogout({
      jti: c.jti,
      iat: c.iat,
      ...(c.sid ? { sid: c.sid } : {}),
      ...(c.sub ? { sub: c.sub } : {}),
      ttlMs: bounds.absoluteMs + bounds.logoutMarkerSlackMs,
    });
    if (!fresh) throw new LogoutReplayError();
    audit("logout.backchannel", { hasSid: Boolean(c.sid), hasSub: Boolean(c.sub) });
  }

  function verifyCsrf(handle: SessionHandle, supplied: unknown): void {
    if (typeof supplied !== "string") throw new CsrfError();
    const a = Buffer.from(supplied);
    const b = Buffer.from(handle.csrf);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CsrfError();
  }

  return {
    bounds,
    start,
    callback,
    current,
    state,
    require,
    logoutLocal,
    logoutEverywhere,
    backchannelLogout,
    verifyCsrf,
  };
}
