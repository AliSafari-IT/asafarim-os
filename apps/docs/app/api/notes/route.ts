/**
 * GET /api/notes[?doc=path]: the caller's own notes (docs.read); POST /api/notes: a new note
 * (docs.notes.write) on a document of the listing (#81).
 */
import { checkTarget, invalid, json, jsonBody, notesAccess } from "@/lib/notes-api";
import { NoteInput } from "@/lib/notes";
import { docParam } from "@/lib/reader";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const a = await notesAccess(false);
  if (!a.ok) return a.res;
  const raw = new URL(request.url).searchParams.get("doc");
  const doc = raw === null ? undefined : docParam(raw);
  if (raw !== null && !doc) return json({ notes: [] });
  return json({ notes: await a.store.list(a.subject, doc) });
}

export async function POST(request: Request) {
  const a = await notesAccess(true);
  if (!a.ok) return a.res;
  const body = await jsonBody(request);
  if (!body.ok) return body.res;
  const input = NoteInput.safeParse(body.body);
  if (!input.success) {
    return invalid("A note needs a document, a body of 1–10 000 characters and a quote of at most 1 000.");
  }
  if (!docParam(input.data.docPath)) return invalid("That document isn't in the source.");
  const target = await checkTarget(input.data.docPath, input.data.headingId);
  if (!target.ok) return target.res;
  return json({ note: await a.store.create(a.subject, { ...input.data, docSha: target.docSha }) }, 201);
}
