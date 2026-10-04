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
}

export function asafarimAuthConfig(opts: AuthConfigOptions) {
  const confidential = Boolean(opts.clientSecret);
  return {
    secret: opts.secret,
    // Behind the OS gateway or on localhost the Host header is the app's own.
    trustHost: true,
    session: { strategy: "jwt" as const },
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
      /** Keep the identity `sub` (and its role claim) on the token. */
      // Generic over the token and session types so Auth.js's own (stricter) types fit.
      jwt<T extends Record<string, unknown>>({
        token,
        profile,
      }: {
        token: T;
        profile?: { sub?: string | null; roles?: unknown };
      }): T {
        const t = token as Record<string, unknown>;
        if (profile?.sub) t.sub = String(profile.sub);
        if (Array.isArray(profile?.roles)) t.roles = profile.roles;
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
