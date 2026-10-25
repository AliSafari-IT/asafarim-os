/**
 * GET /signin/start: start the OIDC sign-in straight away, without the Sign in button. A signed-out
 * visitor lands here (requireAdmin), so someone already signed in to identity (single sign-on: they
 * came from the OS home page's menu, or identity's header) goes through without a click.
 *
 * Starting a sign-in by GET grants nothing: identity still decides who is signed in, and the callback
 * is protected by state and PKCE. A short-lived cookie stops a loop: if the person comes back signed
 * out again within a minute (identity said yes but core-api doesn't accept the token), they get the
 * sign-in page with its button instead of another round trip.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

export const dynamic = "force-dynamic";

const TRIED_COOKIE = "admin-signin-tried";
const TRIED_SECONDS = 60;

export async function GET() {
  const jar = await cookies();
  if (jar.has(TRIED_COOKIE)) redirect("/signin");
  jar.set(TRIED_COOKIE, "1", {
    path: "/signin",
    maxAge: TRIED_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  await signIn("asafarim", { redirectTo: "/admin" });
}
