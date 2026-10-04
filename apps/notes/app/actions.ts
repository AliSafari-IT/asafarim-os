"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/auth";
import { countNotes, createNote } from "@/lib/db";
import { gate } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";

export async function signInAction() {
  await signIn("asafarim", { redirectTo: "/" });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}

export async function createNoteAction(formData: FormData) {
  const g = await gate("notes.write");
  if (!g.ok) {
    const q = new URLSearchParams({ error: g.body.error });
    if (g.body.permission) q.set("permission", g.body.permission);
    redirect(`/?${q}`);
  }
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  if (!title || title.length > 200 || body.length > 10_000) redirect("/?error=invalid_note");
  if ((await countNotes()) >= getPlatform().config.getInt("limits.maxNotes")) redirect("/?error=limit_reached");
  await createNote(g.subject, title, body);
  revalidatePath("/");
  redirect("/");
}
