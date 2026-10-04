/** Sign-in through core/identity (Auth.js generic OIDC, via @asafarim/app-sdk), for the Admin console. */
import { asafarimAuthConfig } from "@asafarim/app-sdk";
import NextAuth from "next-auth";

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
