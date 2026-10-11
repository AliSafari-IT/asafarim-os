import "server-only";
/**
 * What the notes routes share (#81): the gate (docs.read first, then docs.notes.write for a change),
 * the JSON answers and the checks a new note gets against its document.
 */
import { sectionsOf } from "./anchor";
import { gate } from "./gate";
import { docShaOf, getNotes, type NotesStore } from "./notes";
import { getPlatform } from "./platform";
import { DocNotFoundError, getSource, SourceUnavailableError } from "./source";

const NO_STORE = { "cache-control": "private, no-store" };

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

const fail = (status: number, error: string, message: string) => json({ error, message }, status);

/**
 * The caller and the notes, or the answer to send: 401 or 403 (naming docs.read, then
 * docs.notes.write when `write`), 503 without a database.
 */
export async function notesAccess(
  write: boolean,
): Promise<{ ok: true; subject: string; store: NotesStore } | { ok: false; res: Response }> {
  const g = await gate("docs.read");
  if (!g.ok) return { ok: false, res: json(g.body, g.status) };
  if (write) {
    const w = await gate("docs.notes.write");
    if (!w.ok) return { ok: false, res: json(w.body, w.status) };
  }
  const store = getNotes();
  if (!store) return { ok: false, res: fail(503, "notes_unavailable", "Notes aren't available (no database).") };
  return { ok: true, subject: g.subject, store };
}

/** A JSON body, or an answer: a write must say it's JSON (a cross-site form can't). */
export async function jsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return { ok: false, res: fail(415, "unsupported_media_type", "Send the note as application/json.") };
  }
  const body = await request.json().catch(() => undefined);
  if (body === undefined) return { ok: false, res: fail(400, "invalid_json", "The body isn't JSON.") };
  return { ok: true, body };
}

export const invalid = (message: string) => fail(422, "invalid_note", message);
export const notFound = () => fail(404, "not_found", "No such note.");

/**
 * The document a new note is written on: it must be a document of the listing, and its heading one
 * of the document's. Answers with its version (sha-256) or the error to send.
 */
export async function checkTarget(
  docPath: string,
  headingId: string,
): Promise<{ ok: true; docSha: string } | { ok: false; res: Response }> {
  const config = getPlatform().config;
  const source = getSource({ repo: config.getString("source.repo"), branch: config.getString("source.branch") });
  let markdown: string;
  try {
    markdown = await source.readDoc(docPath);
  } catch (err) {
    if (err instanceof DocNotFoundError) return { ok: false, res: invalid("That document isn't in the source.") };
    if (err instanceof SourceUnavailableError) {
      return { ok: false, res: fail(503, "source_unavailable", "Documents temporarily unavailable") };
    }
    throw err;
  }
  if (headingId && !sectionsOf(markdown).some((s) => s.id === headingId)) {
    return { ok: false, res: invalid("That heading isn't in the document.") };
  }
  return { ok: true, docSha: docShaOf(markdown) };
}
