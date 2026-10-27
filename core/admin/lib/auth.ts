/** Sign-in through core/identity (Auth.js generic OIDC, via @asafarim/app-sdk), for the Admin console. */
import { asafarimAuthConfig, endSessionUrl, visitorOrigin } from "@asafarim/app-sdk";
import NextAuth from "next-auth";
import { headers } from "next/headers";

const issuer = process.env.OIDC_ISSUER ?? "http://localhost:4010";

/** The console's OIDC client id: core-api only accepts ID tokens issued to it. */
export const ADMIN_CLIENT_ID = process.env.ADMIN_OIDC_CLIENT_ID ?? "core-admin";

/** identity's ID tokens live one hour; the session is capped to match, so the console never holds a dead one. */
export const SESSION_SECONDS = 3600;

export const { handlers, auth, signIn, signOut } = NextAuth(
  asafarimAuthConfig({
    issuer,
    clientId: ADMIN_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    secret: process.env.AUTH_SECRET,
    keepIdToken: true,
    sessionMaxAgeSeconds: SESSION_SECONDS,
  }),
);

/**
 * Set by sign-out (lib/sign-out.ts), read by /signin/start: someone who just signed out lands on the sign-in page with
 * its button, instead of being sent straight into a new sign-in. Path /signin, so only those pages see it.
 */
export const SIGNED_OUT_COOKIE = "admin-signed-out";

/**
 * Where sign-out continues once the console's session is cleared: identity's end-session page, which ends the
 * ASafariM session too (so the next sign-in asks who you are) and comes back to the console.
 */
export async function endSessionHref(): Promise<string> {
  const origin = visitorOrigin(await headers());
  return endSessionUrl({ issuer, clientId: ADMIN_CLIENT_ID, postLogoutRedirectUri: origin ? `${origin}/` : null });
}
