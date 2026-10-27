/** Sign-in through core/identity (Auth.js generic OIDC, via @asafarim/app-sdk). */
import { asafarimAuthConfig, endSessionUrl, visitorOrigin } from "@asafarim/app-sdk";
import NextAuth from "next-auth";
import { headers } from "next/headers";

const issuer = process.env.OIDC_ISSUER ?? "http://localhost:4010";
const clientId = process.env.ASAFARIM_APP_ID ?? "notes";

export const { handlers, auth, signIn, signOut } = NextAuth(
  asafarimAuthConfig({
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    secret: process.env.AUTH_SECRET,
  }),
);

/**
 * Where sign-out continues once this app's session is cleared: identity's end-session page, which ends the
 * ASafariM session too (so the next sign-in asks who you are) and comes back to this app's home page.
 */
export async function endSessionHref(): Promise<string> {
  const origin = visitorOrigin(await headers());
  return endSessionUrl({ issuer, clientId, postLogoutRedirectUri: origin ? `${origin}/` : null });
}
