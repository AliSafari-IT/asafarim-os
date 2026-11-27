/**
 * A share-button click reported by the page's own script. Public (under /api/public/**), because the reader may be
 * anyone, but it counts only what lib/analytics/store.ts accepts (same-origin, a small JSON body, a published
 * article, a known button) and always answers the same 204, so it tells a caller nothing about what was counted.
 */
import { handleShareRequest } from "@/lib/analytics/store";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    await handleShareRequest(await db(), request);
  } catch {
    // Counting never fails a reader's click.
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
