"use server";
/**
 * The studio's media actions (#359). Each starts at the studio gate. The editor calls the first two around the
 * browser's own upload: request (a pending asset and a presigned PUT), the browser's PUT, then finish (the server
 * checks what arrived). Deleting is a form on the media page.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { deleteAsset, finishUpload, listLibrary, requestUpload, type MediaAsset } from "@/lib/media/assets";
import { getMediaStore } from "@/lib/media/store";
import { createLimiter } from "@/lib/rate-limit";
import { studioGate } from "@/lib/studio";

/** Uploads one person may start: a burst of 20, then 60 an hour. */
const uploads = createLimiter({ perMinute: 1, burst: 20 });

export type UploadTicket =
  { ok: true; id: string; url: string; headers: Record<string, string> } | { ok: false; error: string };

export type UploadDone =
  { ok: true; asset: Pick<MediaAsset, "id" | "kind" | "filename"> } | { ok: false; error: string };

export async function requestUploadAction(input: {
  filename: string;
  contentType: string;
  size: number;
}): Promise<UploadTicket> {
  const g = await studioGate();
  if (!g.ok) return { ok: false, error: g.status === 401 ? "unauthenticated" : g.error };
  const store = getMediaStore();
  if (!store) return { ok: false, error: "media_off" };
  if (!uploads.take(g.actor.subject).ok) return { ok: false, error: "media_rate_limited" };
  return requestUpload(await db(), store, g.actor, input ?? {});
}

export async function finishUploadAction(id: string): Promise<UploadDone> {
  const g = await studioGate();
  if (!g.ok) return { ok: false, error: g.status === 401 ? "unauthenticated" : g.error };
  const store = getMediaStore();
  if (!store) return { ok: false, error: "media_off" };
  const r = await finishUpload(await db(), store, g.actor, typeof id === "string" ? id : "");
  if (!r.ok) return r;
  revalidatePath("/studio/media");
  return { ok: true, asset: { id: r.asset.id, kind: r.asset.kind, filename: r.asset.filename } };
}

/** The person's newest ready assets, for the editor's "choose an uploaded file" (older ones: the Media page). */
export async function listMediaAction(kind?: "image" | "file") {
  const g = await studioGate();
  if (!g.ok) return [];
  const page = await listLibrary(await db(), g.actor, {
    kind: kind === "image" || kind === "file" ? kind : undefined,
    limit: 100,
  });
  return page.items.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename }));
}

export async function deleteMediaAction(formData: FormData) {
  const g = await studioGate();
  if (!g.ok) redirect(g.status === 401 ? "/studio" : `/studio/media?error=${g.error}`);
  const store = getMediaStore();
  if (!store) redirect("/studio/media?error=media_off");
  const id = formData.get("id");
  const r = await deleteAsset(await db(), store, g.actor, typeof id === "string" ? id : "");
  if (!r.ok) redirect(`/studio/media?error=${r.error}`);
  revalidatePath("/studio/media");
  redirect("/studio/media?done=media_deleted");
}
