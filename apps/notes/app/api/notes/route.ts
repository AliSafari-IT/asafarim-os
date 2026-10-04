import { countNotes, createNote, listNotes } from "@/lib/db";
import { gate } from "@/lib/gate";
import { getPlatform } from "@/lib/platform";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gate("notes.read");
  if (!g.ok) return Response.json(g.body, { status: g.status });
  return Response.json({ notes: await listNotes(100) });
}

export async function POST(request: Request) {
  const g = await gate("notes.write");
  if (!g.ok) return Response.json(g.body, { status: g.status });

  const input = (await request.json().catch(() => null)) as { title?: unknown; body?: unknown } | null;
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const body = typeof input?.body === "string" ? input.body : "";
  if (!title || title.length > 200 || body.length > 10_000) {
    return Response.json(
      { error: "invalid_note", message: "A title of 1–200 characters is required; the body may be up to 10 000." },
      { status: 422 },
    );
  }
  const max = getPlatform().config.getInt("limits.maxNotes");
  if ((await countNotes()) >= max) {
    return Response.json(
      { error: "limit_reached", max, message: `The app keeps at most ${max} notes.` },
      { status: 409 },
    );
  }
  return Response.json({ note: await createNote(g.subject, title, body) }, { status: 201 });
}
