"use server";

import { ACCESS_COOKIE_NAME } from "@asafarim/app-sdk";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { endSessionHref, signIn, signOut } from "@/lib/auth";
import { gate } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";
import { docParam } from "@/lib/reader";
import { getSource } from "@/lib/source";

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
  await signOut({ redirect: false });
  // Then out of identity too: otherwise "Sign in" goes straight back into the same account without asking.
  redirect(await endSessionHref());
}

/** The Refresh button: forget the cached tree and files, then show the same document again. */
export async function refreshAction(formData: FormData) {
  const doc = docParam(formData.get("doc"));
  const g = await gate("docs.read");
  if (g.ok) {
    const config = getPlatform().config;
    getSource({ repo: config.getString("source.repo"), branch: config.getString("source.branch") }).refresh();
  }
  redirect(doc ? `/?doc=${encodeURIComponent(doc)}` : "/");
}
