/**
 * An Auth.js (next-auth v5) configuration that signs people in through
 * core/identity (P3.2). The SDK has no dependency on next-auth: this returns
 * the plain config object to pass to `NextAuth(...)`.
 *
 *   export const { handlers, auth, signIn, signOut } = NextAuth(
 *     asafarimAuthConfig({ issuer, clientId }),
 *   );
 *
 * - Authorization code + PKCE (S256) + state + nonce, scopes
 *   `openid email profile roles`; a public client (no secret) unless
 *   `clientSecret` is given.
 * - The session is a JWT in a host-only `__Host-` cookie: Secure, HttpOnly,
 *   SameSite=Lax, Path=/, and no Domain, so it can't be read by, or leak to,
 *   another app or subdomain. (Browsers accept Secure cookies on http://localhost.)
 * - `session.user.id` is the identity `sub`, the subject permissions are
 *   resolved for.
 */
export const SESSION_COOKIE_NAME = "__Host-asafarim.session-token";

export interface AuthConfigOptions {
  /** The identity issuer, e.g. https://id.asafarim.site (http://localhost:4010 in development). */
  issuer: string;
  /** The app's OIDC client id (its app id). */
  clientId: string;
  /** Omit for a public client (PKCE only). */
  clientSecret?: string;
  /** Auth.js's own secret (AUTH_SECRET); signs and encrypts the session JWT. */
  secret?: string;
  /**
   * Keep the ID token inside the encrypted session cookie (as `token.idToken`), for an app that has
   * to present it to core-api on the person's behalf: the Admin console. It is NOT put in the
   * session object, which `/api/auth/session` hands to the browser; read it on the server with
   * `getToken` from `next-auth/jwt`.
   */
  keepIdToken?: boolean;
  /**
   * How long a person stays signed in to this app, in seconds, counted from sign-in (default: identity's own session,
   * IDENTITY_SESSION_SECONDS). It is an absolute limit: Auth.js re-signs the session on every request, which would
   * otherwise keep it alive for as long as the person is active. The console sets it to the ID token's lifetime.
   */
  sessionMaxAgeSeconds?: number;
}

/**
 * How long identity's own session lasts (AUTH_SESSION_TTL_SECONDS in core/identity/src/auth-session.ts: keep the two
 * equal). An app's session ends no later, so an app never shows someone as signed in after the OS home page
 * (asafarim.site, which asks identity) and identity's account page no longer do.
 */
export const IDENTITY_SESSION_SECONDS = 12 * 3600;

export function asafarimAuthConfig(opts: AuthConfigOptions) {
  const confidential = Boolean(opts.clientSecret);
  const maxAge = opts.sessionMaxAgeSeconds ?? IDENTITY_SESSION_SECONDS;
  return {
    secret: opts.secret,
    // Behind the OS gateway or on localhost the Host header is the app's own.
    trustHost: true,
    session: {
      strategy: "jwt" as const,
      maxAge,
    },
    providers: [
      {
        id: "asafarim",
        name: "ASafariM",
        type: "oidc" as const,
        issuer: opts.issuer.replace(/\/$/, ""),
        clientId: opts.clientId,
        ...(confidential ? { clientSecret: opts.clientSecret } : {}),
        client: { token_endpoint_auth_method: confidential ? ("client_secret_basic" as const) : ("none" as const) },
        checks: ["pkce", "state", "nonce"] as ("pkce" | "state" | "nonce")[],
        authorization: { params: { scope: "openid email profile roles" } },
      },
    ],
    cookies: {
      sessionToken: {
        name: SESSION_COOKIE_NAME,
        options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure: true },
      },
    },
    callbacks: {
      /**
       * Keep the identity `sub` (and its role claim) on the token, and when the person signed in: the session ends
       * `maxAge` seconds after that, however active they are (null makes Auth.js clear it). A token without the
       * stamp is from before this limit existed, and ends too: the person signs in once more.
       */
      // Generic over the token and session types so Auth.js's own (stricter) types fit.
      jwt<T extends Record<string, unknown>>({
        token,
        profile,
        account,
      }: {
        token: T;
        profile?: { sub?: string | null; roles?: unknown };
        account?: { id_token?: string | null } | null;
      }): T | null {
        const t = token as Record<string, unknown>;
        const now = Math.floor(Date.now() / 1000);
        if (account) t.signedInAt = now;
        const signedInAt = t.signedInAt;
        if (typeof signedInAt !== "number" || now - signedInAt >= maxAge) return null;
        if (profile?.sub) t.sub = String(profile.sub);
        if (Array.isArray(profile?.roles)) t.roles = profile.roles;
        // Only at sign-in (that's when `account` exists), and only when asked for.
        if (opts.keepIdToken && account?.id_token) t.idToken = account.id_token;
        return token;
      },
      session<S extends { user?: object | null }>({
        session,
        token,
      }: {
        session: S;
        token: Record<string, unknown>;
      }): S {
        if (session.user && token.sub) (session.user as Record<string, unknown>).id = String(token.sub);
        return session;
      },
    },
  };
}

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

/** Wrap an Auth.js route handler (`handlers.GET` / `handlers.POST`) so it sees the visitor's origin. */
export function forwardedOrigin<R extends Request, T>(handler: (request: R) => T): (request: R) => T {
  return (request) => handler(withForwardedOrigin(request) as R);
}
