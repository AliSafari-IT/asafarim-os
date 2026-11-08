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
 * equal; scripts/session-ttl.test.mjs fails if they differ). By default an app's session ends no later, so an app never
 * shows someone as signed in after the OS home page (asafarim.site, which asks identity) and identity's account page no
 * longer do. A `sessionMaxAgeSeconds` above this lets the app's session outlast identity's.
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

// The forwarded-origin and end-session helpers live in the core (shared with the plain Node adapter) and are re-exported
// here so this subpath keeps the exact export list `@asafarim/app-sdk` had.
export { endSessionUrl, forwardedOrigin, visitorOrigin, withForwardedOrigin } from "./origin.js";
