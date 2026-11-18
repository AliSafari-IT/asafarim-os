/**
 * Keyset pagination cursors: the sort key of the last row on a page (a timestamp, exactly as PostgreSQL printed it,
 * and the row's id), as opaque base64url text in the URL. A cursor that doesn't decode is treated as "no cursor"
 * (the first page), never as an error and never passed to SQL unchecked.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// PostgreSQL's text form of a timestamptz, e.g. "2026-11-18 22:20:13.123456+00".
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/;

export interface Cursor {
  at: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.at}|${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const bar = text.lastIndexOf("|");
  if (bar < 0) return null;
  const at = text.slice(0, bar);
  const id = text.slice(bar + 1);
  return PG_TIMESTAMP.test(at) && UUID.test(id) ? { at, id } : null;
}

/** A revision-history page boundary: show revisions numbered below this. */
export function parseBefore(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d{0,8}$/.test(raw)) return null;
  return Number(raw);
}
