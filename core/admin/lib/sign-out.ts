"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SIGNED_OUT_COOKIE, endSessionHref, signOut } from "@/lib/auth";

const SIGNED_OUT_SECONDS = 600;

/**
 * Sign out of the console, then out of identity too (its end-session page), so the next sign-in asks who you are
 * instead of going straight back into the same account. identity comes back to the console's home page.
 */
export async function signOutAction() {
  await signOut({ redirect: false });
  (await cookies()).set(SIGNED_OUT_COOKIE, "1", {
    path: "/signin",
    maxAge: SIGNED_OUT_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  redirect(await endSessionHref());
}
