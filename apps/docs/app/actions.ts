"use server";

import { ACCESS_COOKIE_NAME } from "@asafarim/app-sdk";
import { cookies } from "next/headers";
import { signIn, signOut } from "@/lib/auth";

export async function signInAction() {
  await signIn("asafarim", { redirectTo: "/" });
}

export async function signOutAction() {
  // Drop the gateway's access token with the session (a __Host- cookie: Secure, Path=/, no Domain).
  (await cookies()).set(ACCESS_COOKIE_NAME, "", {
    maxAge: 0,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
  await signOut({ redirectTo: "/" });
}
