"use server";

import { ACCESS_COOKIE_NAME } from "@asafarim/app-sdk";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { endSessionHref, signIn, signOut } from "@/lib/auth";

/** Only a path on this site: never `//host` or a URL, so sign-in can't be turned into an open redirect. */
function safeNext(value: FormDataEntryValue | null): string {
  const s = typeof value === "string" ? value : "";
  return /^\/(?![/\\])[^\s]*$/.test(s) ? s : "/";
}

export async function signInAction(formData?: FormData) {
  await signIn("asafarim", { redirectTo: safeNext(formData?.get("next") ?? null) });
}

export async function signOutAction() {
  // Drop the gateway's access token with the session. A __Host- cookie is only accepted (or removed)
  // with Secure, Path=/ and no Domain, so it's set expired with exactly those attributes.
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
