/**
 * PATCH /api/notes/:id (a new body) and DELETE /api/notes/:id, for docs.notes.write, on the caller's
 * own notes only: anyone else's note is "not found" (#81).
 */
import { invalid, json, jsonBody, notesAccess, notFound } from "@/lib/notes-api";
import { NoteEdit, noteId } from "@/lib/notes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const a = await notesAccess(true);
  if (!a.ok) return a.res;
  const id = noteId((await params).id);
  if (!id) return notFound();
  const body = await jsonBody(request);
  if (!body.ok) return body.res;
  const edit = NoteEdit.safeParse(body.body);
  if (!edit.success) return invalid("A note's body is 1–10 000 characters.");
  const note = await a.store.update(a.subject, id, edit.data.body);
  return note ? json({ note }) : notFound();
}

export async function DELETE(_request: Request, { params }: Params) {
  const a = await notesAccess(true);
  if (!a.ok) return a.res;
  const id = noteId((await params).id);
  if (!id || !(await a.store.remove(a.subject, id))) return notFound();
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
}
