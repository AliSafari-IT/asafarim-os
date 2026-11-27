/**
 * /api/engagement/**: likes and comments on lessons (lib/engagement.ts). Reading and liking are public; writing a
 * comment needs knowledge.comment.write and deleting someone else's knowledge.comment.moderate, both checked by
 * the app on every request (lib/engagement.ts says why not at the gateway).
 */
import { NextResponse } from "next/server";
import { engagementHandlers } from "@/lib/engagement";

export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const handlers = engagementHandlers();
  if (!handlers) {
    return NextResponse.json(
      { error: { code: "unavailable", message: "Likes and comments are switched off." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    return (await handlers).handle(request);
  } catch (err) {
    console.error(
      JSON.stringify({
        app: "knowledge",
        level: "error",
        msg: "engagement.unavailable",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json(
      { error: { code: "unavailable", message: "Likes and comments are unavailable right now." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
