/**
 * Forwarded-origin helpers, moved here unchanged from `@asafarim/app-sdk` (`src/auth.ts`). They are used by the
 * Auth.js adapter (which keeps `trustHost: true` behaviour) and are plain functions over `Request`/`Headers`.
 * The plain Node adapter does not use them to build redirect URIs: it takes its origin from configuration.
 */
const FORWARDED_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;

/**
 * The request as the visitor made it: behind the OS gateway (or any proxy) a Next.js route
 * handler sees its OWN origin in `request.url` (http://localhost:4100), and Auth.js builds the
 * OIDC `redirect_uri` for the token exchange from it, so it no longer matches the one sent
 * when sign-in started (that one comes from the forwarded headers, in the server action) and
 * identity answers `invalid_grant`. This puts the forwarded host and protocol back into the URL.
 *
 * It honours `x-forwarded-host` / `x-forwarded-proto` only when they look like a host and a
 * scheme, and only the same way `trustHost: true` already does for sign-in: the gateway
 * sets them, and an app is never exposed except through it (ADR 0001 §7).
 */
export function withForwardedOrigin(request: Request): Request {
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (!host || !FORWARDED_HOST.test(host)) return request;
  const url = new URL(request.url);
  if (proto === "http" || proto === "https") url.protocol = `${proto}:`;
  // Hostname and port separately: setting `host` without a port would keep the app's own (4100).
  const [hostname, port = ""] = host.split(":") as [string, string?];
  url.hostname = hostname;
  url.port = port;
  if (url.href === request.url) return request;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? request.body : undefined,
    redirect: request.redirect,
    signal: request.signal,
    // A streamed body needs this in Node's fetch implementation.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

/**
 * The visitor's origin (`https://docs.asafarim.site`) from the request headers: the forwarded host and protocol the
 * gateway sets, else the Host header. Same rules as {@link withForwardedOrigin}; null when no header looks like a host.
 */
export function visitorOrigin(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded && FORWARDED_HOST.test(forwarded) ? forwarded : headers.get("host")?.trim();
  if (!host || !FORWARDED_HOST.test(host)) return null;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const local = /^(localhost|127\.0\.0\.1|[^:]+\.localhost)(:\d+)?$/.test(host);
  const scheme = proto === "http" || proto === "https" ? proto : local ? "http" : "https";
  return `${scheme}://${host}`;
}

/**
 * Where an app sends the browser after clearing its own session: identity's end-session endpoint (OIDC RP-initiated
 * logout). Clearing the app's cookie alone leaves identity's session in place, so the next "Sign in" lands straight
 * back in the same account without asking. identity confirms, ends its session, and sends the browser to
 * `postLogoutRedirectUri`, which must be one of the client's post-logout URIs (identity registers
 * `https://<primary_domain>/` when the client lists none).
 *
 *   await signOut({ redirect: false });
 *   redirect(endSessionUrl({ issuer, clientId, postLogoutRedirectUri: `${visitorOrigin(await headers())}/` }));
 */
export function endSessionUrl(opts: {
  issuer: string;
  clientId: string;
  postLogoutRedirectUri?: string | null;
}): string {
  const url = new URL(`${opts.issuer.replace(/\/$/, "")}/session/end`);
  url.searchParams.set("client_id", opts.clientId);
  if (opts.postLogoutRedirectUri) url.searchParams.set("post_logout_redirect_uri", opts.postLogoutRedirectUri);
  return url.href;
}

/** Wrap an Auth.js route handler (`handlers.GET` / `handlers.POST`) so it sees the visitor's origin. */
export function forwardedOrigin<R extends Request, T>(handler: (request: R) => T): (request: R) => T {
  return (request) => handler(withForwardedOrigin(request) as R);
}
