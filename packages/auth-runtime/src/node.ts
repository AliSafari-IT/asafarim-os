/**
 * The plain Node adapter: sign-in, callback, sign-out, back-channel logout and a session-state endpoint over `node:http`
 * (or any Web `Request` → `Response` host), with host-only `__Host-` cookies. No React, no Auth.js, no framework.
 *
 * Every URL the adapter builds comes from configuration (`origin`), never from request headers: the redirect URI is exact,
 * and forwarded host headers are ignored.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { clearCookie, assertHostCookieName, readCookie, serializeCookie } from "./cookies.ts";
import {
  AuthRuntimeError,
  CsrfError,
  InvalidConfigError,
  PayloadTooLargeError,
  StepUpRequiredError,
  type AuthRuntimeError as AuthRuntimeErrorType,
} from "./errors.ts";
import { createOidcClient, type OidcClient, type OidcClientOptions } from "./oidc.ts";
import { normalizeOrigin } from "./return-target.ts";
import {
  createSessionRuntime,
  type SessionHandle,
  type SessionRuntime,
  type SessionRuntimeOptions,
} from "./session.ts";
import type { SessionState } from "./types.ts";

export interface NodeAuthOptions<A = unknown>
  extends
    Omit<SessionRuntimeOptions<A>, "oidc">,
    Pick<
      OidcClientOptions,
      | "issuer"
      | "clientId"
      | "clientSecret"
      | "scope"
      | "idTokenSigningAlg"
      | "logoutTokenAlgorithms"
      | "logoutTokenMaxAgeMs"
      | "timeoutMs"
      | "allowInsecureHttp"
      | "fetch"
    > {
  /** Route prefix. Default `/auth`. */
  prefix?: string;
  cookies?: { session?: string; flow?: string };
  /** Where the browser lands after "sign out everywhere". Must be registered with the provider. Default `<origin>/`. */
  postLogoutRedirectUri?: string;
  /** Include a display hint (the e-mail the provider vouched for) in `/session`. Default false: the body is `status`, `authorized`, `fresh`. */
  exposeDisplayHint?: boolean;
  /** Use a prebuilt OIDC client instead of building one from the issuer options. */
  oidc?: OidcClient;
}

export interface NodeAuth {
  readonly runtime: SessionRuntime;
  readonly paths: {
    start: string;
    callback: string;
    logout: string;
    logoutEverywhere: string;
    backchannelLogout: string;
    session: string;
  };
  /** The Web handler. Returns null when the path is not one of the adapter's routes. */
  handleRequest(request: Request): Promise<Response | null>;
  /** The `node:http` handler. Returns false when the path is not one of the adapter's routes (nothing was written). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  sessionIdOf(source: { headers: Headers } | IncomingMessage): string | undefined;
  current(source: { headers: Headers } | IncomingMessage, o?: { touch?: boolean }): Promise<SessionHandle | null>;
  state(source: { headers: Headers } | IncomingMessage, o?: { touch?: boolean }): Promise<SessionState>;
  /** Guard a route or API. A failed freshness check carries `restartUrl` (the sign-in start URL with `fresh=1`). */
  require(
    source: { headers: Headers } | IncomingMessage,
    o?: { policy?: string; fresh?: boolean; returnTo?: string },
  ): Promise<SessionHandle>;
  /** `/auth/start?...` for a link or a redirect. */
  startUrl(o?: { returnTo?: string; fresh?: boolean; intent?: string; locale?: string }): string;
}

const BODY_LIMIT = 4096;
const BACKCHANNEL_LIMIT = 16 * 1024;

const NO_STORE = { "cache-control": "no-store" } as const;

export function createNodeAuth<A = unknown>(opts: NodeAuthOptions<A>): NodeAuth {
  const origin = normalizeOrigin(opts.origin);
  const prefix = opts.prefix ?? "/auth";
  if (!/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/.test(prefix)) throw new InvalidConfigError("invalid route prefix");
  const paths = {
    start: `${prefix}/start`,
    callback: `${prefix}/callback`,
    logout: `${prefix}/logout`,
    logoutEverywhere: `${prefix}/logout/everywhere`,
    backchannelLogout: `${prefix}/backchannel-logout`,
    session: `${prefix}/session`,
  };
  const sessionCookie = opts.cookies?.session ?? "__Host-asafarim.sid";
  const flowCookie = opts.cookies?.flow ?? "__Host-asafarim.flow";
  assertHostCookieName(sessionCookie);
  assertHostCookieName(flowCookie);
  if (sessionCookie === flowCookie) throw new InvalidConfigError("session and flow cookies must differ");
  const postLogout = opts.postLogoutRedirectUri ?? `${origin}/`;

  const oidc =
    opts.oidc ??
    createOidcClient({
      issuer: opts.issuer,
      clientId: opts.clientId,
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      redirectUri: `${origin}${paths.callback}`,
      postLogoutRedirectUri: postLogout,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.idTokenSigningAlg ? { idTokenSigningAlg: opts.idTokenSigningAlg } : {}),
      ...(opts.logoutTokenAlgorithms ? { logoutTokenAlgorithms: opts.logoutTokenAlgorithms } : {}),
      ...(opts.logoutTokenMaxAgeMs ? { logoutTokenMaxAgeMs: opts.logoutTokenMaxAgeMs } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  const runtime = createSessionRuntime<A>({
    oidc,
    origin,
    store: opts.store,
    flows: opts.flows,
    bounds: opts.bounds,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.policies ? { policies: opts.policies } : {}),
    ...(opts.needsTokens ? { needsTokens: true } : {}),
    ...(opts.allowedReturnOrigins ? { allowedReturnOrigins: opts.allowedReturnOrigins } : {}),
    ...(opts.defaultReturnTo ? { defaultReturnTo: opts.defaultReturnTo } : {}),
    ...(opts.locales ? { locales: opts.locales } : {}),
    ...(opts.defaultLocale ? { defaultLocale: opts.defaultLocale } : {}),
    ...(opts.intents ? { intents: opts.intents } : {}),
    ...(opts.flowTtlMs ? { flowTtlMs: opts.flowTtlMs } : {}),
    ...(opts.deps ? { deps: opts.deps } : {}),
  });
  const deps = opts.deps ?? {};
  const log = (event: string, err?: unknown) =>
    deps.log?.({ event, ...(err instanceof AuthRuntimeError ? { code: err.code } : {}) });

  const headersOf = (source: { headers: Headers } | IncomingMessage): Headers => {
    if (source.headers instanceof Headers) return source.headers;
    const h = new Headers();
    for (const [k, v] of Object.entries(source.headers as IncomingMessage["headers"])) {
      if (typeof v === "string") h.set(k, v);
      else if (Array.isArray(v)) h.set(k, v.join("; "));
    }
    return h;
  };
  const sessionIdOf = (source: { headers: Headers } | IncomingMessage) =>
    readCookie(headersOf(source).get("cookie"), sessionCookie);

  const startUrl: NodeAuth["startUrl"] = (o = {}) => {
    const q = new URLSearchParams();
    if (o.returnTo) q.set("return", o.returnTo);
    if (o.fresh) q.set("fresh", "1");
    if (o.intent) q.set("intent", o.intent);
    if (o.locale) q.set("locale", o.locale);
    const s = q.toString();
    return `${paths.start}${s ? `?${s}` : ""}`;
  };

  // ---- responses ---------------------------------------------------------------------------------------------------

  function text(status: number, body: string, extra: [string, string][] = []): Response {
    const h = new Headers({ ...NO_STORE, "content-type": "text/plain; charset=utf-8" });
    for (const [k, v] of extra) h.append(k, v);
    return new Response(body, { status, headers: h });
  }
  function redirect(location: string, cookies: string[] = [], status = 303): Response {
    const h = new Headers({ ...NO_STORE, location });
    for (const c of cookies) h.append("set-cookie", c);
    return new Response(null, { status, headers: h });
  }
  function failure(err: unknown, cookies: string[] = []): Response {
    const e: AuthRuntimeErrorType =
      err instanceof AuthRuntimeError ? err : (new InvalidConfigError("unexpected") as AuthRuntimeErrorType);
    log("auth.failed", e);
    // Only the stable code goes to the browser: no message, no reason, nothing from the request.
    const extra: [string, string][] = cookies.map((c) => ["set-cookie", c]);
    return text(e instanceof AuthRuntimeError ? e.status : 500, `Sign-in problem (${e.code}).`, extra);
  }

  async function readForm(request: Request, limit: number): Promise<URLSearchParams> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError();
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => undefined);
          throw new PayloadTooLargeError();
        }
        chunks.push(value);
      }
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }
  const single = (form: URLSearchParams, name: string): string | undefined => {
    const all = form.getAll(name);
    return all.length === 1 ? all[0] : undefined;
  };

  /** A state-changing request must come from the app's own origin. */
  function sameOrigin(request: Request): void {
    if (request.headers.get("origin") !== origin) throw new CsrfError();
  }

  // ---- routes ------------------------------------------------------------------------------------------------------

  async function onStart(request: Request, url: URL): Promise<Response> {
    const q = url.searchParams;
    try {
      const r = await runtime.start({
        ...(q.get("return") ? { returnTo: q.get("return")! } : {}),
        ...(q.get("locale") ? { locale: q.get("locale")! } : {}),
        ...(q.get("intent") ? { intent: q.get("intent")! } : {}),
        fresh: q.get("fresh") === "1",
      });
      return redirect(r.redirect, [serializeCookie(flowCookie, r.flowId, { maxAgeSec: r.flowMaxAgeSec })], 303);
    } catch (err) {
      return failure(err);
    }
  }

  async function onCallback(request: Request, url: URL): Promise<Response> {
    const cookieHeader = request.headers.get("cookie");
    try {
      const r = await runtime.callback({
        query: url.searchParams,
        flowId: readCookie(cookieHeader, flowCookie),
        previousSessionId: readCookie(cookieHeader, sessionCookie),
      });
      const target = r.returnTo.startsWith("/") ? `${origin}${r.returnTo}` : r.returnTo;
      return redirect(target, [
        serializeCookie(sessionCookie, r.sessionId, { maxAgeSec: r.maxAgeSec }),
        clearCookie(flowCookie),
      ]);
    } catch (err) {
      // The flow is spent whatever happened; make the browser forget it too.
      return failure(err, [clearCookie(flowCookie)]);
    }
  }

  async function onLogout(request: Request, everywhere: boolean): Promise<Response> {
    try {
      sameOrigin(request);
      const id = readCookie(request.headers.get("cookie"), sessionCookie);
      if (id) {
        const handle = await runtime.current(id, { touch: false });
        if (handle) {
          const form = await readForm(request, BODY_LIMIT);
          runtime.verifyCsrf(handle, single(form, "csrf"));
        }
      }
      const clear = clearCookie(sessionCookie);
      if (everywhere) {
        const r = await runtime.logoutEverywhere(id, { postLogoutRedirectUri: postLogout });
        return redirect(r.redirect, [clear]);
      }
      await runtime.logoutLocal(id);
      return redirect(`${origin}/`, [clear]);
    } catch (err) {
      return failure(err);
    }
  }

  async function onBackchannel(request: Request): Promise<Response> {
    if (request.method !== "POST") return text(405, "Method not allowed.", [["allow", "POST"]]);
    try {
      const form = await readForm(request, BACKCHANNEL_LIMIT);
      const token = single(form, "logout_token");
      if (!token) return new Response(null, { status: 400, headers: NO_STORE });
      await runtime.backchannelLogout(token);
      return new Response(null, { status: 200, headers: NO_STORE });
    } catch (err) {
      log("auth.backchannel_failed", err);
      // No detail about why a token was refused.
      const status = err instanceof AuthRuntimeError ? err.status : 500;
      return new Response(null, {
        status: [400, 413, 429, 503].includes(status) ? status : status >= 500 ? 503 : 400,
        headers: NO_STORE,
      });
    }
  }

  async function onSession(request: Request): Promise<Response> {
    try {
      const s = await runtime.state(readCookie(request.headers.get("cookie"), sessionCookie), { touch: false });
      const body = {
        status: s.status,
        authorized: s.authorized,
        fresh: s.fresh,
        ...(opts.exposeDisplayHint && s.displayHint ? { displayHint: s.displayHint } : {}),
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { ...NO_STORE, "content-type": "application/json" },
      });
    } catch (err) {
      log("auth.session_failed", err);
      // An outage is not "signed out": say so, so the page does not show a wrong state.
      return new Response(JSON.stringify({ status: "unavailable" }), {
        status: 503,
        headers: { ...NO_STORE, "content-type": "application/json" },
      });
    }
  }

  async function handleRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!Object.values(paths).includes(path)) return null;
    const method = request.method;
    if (path === paths.backchannelLogout) return onBackchannel(request);
    if (path === paths.start)
      return method === "GET" ? onStart(request, url) : text(405, "Method not allowed.", [["allow", "GET"]]);
    if (path === paths.callback)
      return method === "GET" ? onCallback(request, url) : text(405, "Method not allowed.", [["allow", "GET"]]);
    if (path === paths.session)
      return method === "GET" ? onSession(request) : text(405, "Method not allowed.", [["allow", "GET"]]);
    if (path === paths.logout || path === paths.logoutEverywhere)
      return method === "POST"
        ? onLogout(request, path === paths.logoutEverywhere)
        : text(405, "Method not allowed.", [["allow", "POST"]]);
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const target = req.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) return false;
    const path = target.split("?")[0]!;
    if (!Object.values(paths).includes(path)) return false;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(`${origin}${target}`, {
      method,
      headers,
      ...(hasBody ? { body: req as unknown as ReadableStream, duplex: "half" } : {}),
    } as RequestInit);
    const response = await handleRequest(request);
    if (!response) return false;
    await writeResponse(res, response);
    return true;
  }

  return {
    runtime,
    paths,
    handleRequest,
    handle,
    sessionIdOf,
    current: (source, o) => runtime.current(sessionIdOf(source), o),
    state: (source, o) => runtime.state(sessionIdOf(source), o),
    async require(source, o = {}) {
      try {
        return await runtime.require(sessionIdOf(source), {
          ...(o.policy ? { policy: o.policy } : {}),
          ...(o.fresh ? { fresh: true } : {}),
        });
      } catch (err) {
        if (err instanceof StepUpRequiredError)
          throw new StepUpRequiredError(startUrl({ fresh: true, ...(o.returnTo ? { returnTo: o.returnTo } : {}) }));
        throw err;
      }
    },
    startUrl,
  };
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

export interface SessionStateHandlerOptions {
  auth: Pick<NodeAuth, "state">;
  /** Exact origins that may read the answer (for example the public site). Never `*`, never reflected unvalidated. */
  allowedOrigins: readonly string[];
  exposeDisplayHint?: boolean;
}

/**
 * A cross-origin session-state endpoint for a public page that shows "signed in / management" without sharing cookies:
 * GET only, exact-origin allow-list, credentials allowed, `Vary: Origin`, `no-store`, and a minimal body.
 * Mount it on the app's own host (where its host-only cookie lives).
 */
export function createSessionStateHandler(o: SessionStateHandlerOptions): (request: Request) => Promise<Response> {
  const allowed = new Set(o.allowedOrigins.map(normalizeOrigin));
  return async (request) => {
    const origin = request.headers.get("origin");
    const base = { ...NO_STORE, vary: "Origin" };
    if (origin !== null && !allowed.has(origin)) return new Response(null, { status: 403, headers: base });
    const cors: Record<string, string> = origin
      ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" }
      : {};
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...base, ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "600" },
      });
    }
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { ...base, allow: "GET, OPTIONS" } });
    try {
      const s = await o.auth.state(request, { touch: false });
      const body = {
        status: s.status,
        authorized: s.authorized,
        ...(o.exposeDisplayHint && s.displayHint ? { displayHint: s.displayHint } : {}),
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { ...base, ...cors, "content-type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ status: "unavailable" }), {
        status: 503,
        headers: { ...base, ...cors, "content-type": "application/json" },
      });
    }
  };
}
