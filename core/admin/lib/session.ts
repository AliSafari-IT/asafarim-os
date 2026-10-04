/**
 * Who is looking at the console, and may they? Resolved once per request:
 *   signed-out  no session, or the ID token has expired → the sign-in page
 *   forbidden   signed in, but core-api says they don't hold core.admin → a real 403
 *   ok          an administrator
 * The ID token stays on the server: it is read from the encrypted session cookie, never from
 * the session object that Auth.js sends to the browser.
 */
import { SESSION_COOKIE_NAME } from "@asafarim/app-sdk";
import { cookies } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { getToken } from "next-auth/jwt";
import { cache } from "react";
import { CoreApiError, coreApi } from "./core-api";
import { idTokenExpired } from "./util";

export type AdminState =
  | { state: "ok"; idToken: string; subject: string; name: string }
  | { state: "signed-out" }
  | { state: "forbidden"; subject: string };

export const adminState = cache(async (): Promise<AdminState> => {
  const jar = await cookies();
  const token = await getToken({
    req: { headers: new Headers({ cookie: jar.toString() }) },
    secret: process.env.AUTH_SECRET,
    cookieName: SESSION_COOKIE_NAME,
  });
  const idToken = typeof token?.idToken === "string" ? token.idToken : undefined;
  if (!token || !idToken || idTokenExpired(idToken)) return { state: "signed-out" };
  const subject = String(token.sub ?? "");
  try {
    await coreApi(idToken).session();
  } catch (err) {
    if (err instanceof CoreApiError && err.status === 401) return { state: "signed-out" };
    if (err instanceof CoreApiError && err.status === 403) return { state: "forbidden", subject };
    throw err; // core-api down: the error page, not a wrong answer
  }
  return { state: "ok", idToken, subject, name: typeof token.name === "string" ? token.name : subject };
});

/** For pages, layouts and server actions: an administrator, or a redirect to sign-in, or a 403. */
export async function requireAdmin() {
  const s = await adminState();
  if (s.state === "signed-out") redirect("/signin");
  if (s.state === "forbidden") forbidden();
  return s;
}
