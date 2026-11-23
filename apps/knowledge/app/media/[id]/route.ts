/**
 * GET /media/:id (#359): one uploaded asset's bytes, streamed from the private store. Public while a public revision
 * uses it (cacheable); otherwise only for a signed-in person who may see it (private, never stored). Anyone else,
 * and any id that isn't a ready asset, gets the same 404. Served so it can never run as a page here: the type is
 * the one checked at upload, nosniff, a sandboxing CSP, and files are downloads.
 */
import { db } from "@/lib/db";
import { assetKey, readableAsset } from "@/lib/media/assets";
import { getMediaStore } from "@/lib/media/store";
import { studioGate } from "@/lib/studio";

export const dynamic = "force-dynamic";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getMediaStore();
  if (!store) return notFound();
  const pool = await db();
  // Guests first: a public asset needs no sign-in check at all.
  let found = await readableAsset(pool, null, id);
  if (!found) {
    const g = await studioGate();
    if (!g.ok) return notFound();
    found = await readableAsset(pool, g.actor, id);
    if (!found) return notFound();
  }
  const body = await store.open(assetKey(found.asset.id));
  if (!body) return notFound();
  const { asset, isPublic } = found;
  const ascii = asset.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(body, {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.byteSize),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition":
        asset.kind === "image"
          ? "inline"
          : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
      // Short for public media: a withdrawn article's images stop being served within minutes, even from caches.
      "Cache-Control": isPublic ? "public, max-age=300" : "private, no-store",
      ...(isPublic ? {} : { "X-Robots-Tag": "noindex" }),
    },
  });
}
