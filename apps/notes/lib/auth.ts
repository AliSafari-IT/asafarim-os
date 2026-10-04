/** Sign-in through core/identity (Auth.js generic OIDC, via @asafarim/app-sdk). */
import { asafarimAuthConfig } from "@asafarim/app-sdk";
import NextAuth from "next-auth";

const issuer = process.env.OIDC_ISSUER ?? "http://localhost:4010";

export const { handlers, auth, signIn, signOut } = NextAuth(
  asafarimAuthConfig({
    issuer,
    clientId: process.env.ASAFARIM_APP_ID ?? "notes",
    clientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    secret: process.env.AUTH_SECRET,
  }),
);
