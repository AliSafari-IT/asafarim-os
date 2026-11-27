/**
 * Who wrote what, in words. The database knows articles only by the author's identifier (a subject), and the
 * platform SDK can check permissions but can't look a person up, so the app keeps the display name each author's
 * own sign-in presented: one row per author in `authors`, refreshed whenever they use the studio.
 *
 * Public, so held to a strict rule: only a *name*. An email address is never a name here, and is never stored.
 */
import type pg from "pg";

/** The longest name kept (the table checks the same limit). */
export const MAX_NAME = 80;

// Invisible characters that can reorder or hide text around a name: control characters (\p{Cc}), the zero-width
// space, the left-to-right and right-to-left marks, the line and paragraph separators, the bidirectional
// embeddings, overrides and isolates, and the byte-order mark. The zero-width joiner and non-joiner stay: some
// scripts (Persian, Indic) spell real names with them.
const INVISIBLE = /[\p{Cc}\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu;

/** A name fit to show the public, or null when there isn't one (empty, or it looks like an email address). */
export function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  if (!name) return null;
  if (name.includes("@")) return null;
  return name;
}

/** Up to two letters for an avatar: "Ali Safari" is "AS", "Madonna" is "MA". */
export function initialsOf(name: string | null): string {
  const words = (name ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "K";
  const letters =
    words.length === 1
      ? Array.from(words[0]!).slice(0, 2)
      : [Array.from(words[0]!)[0]!, Array.from(words[words.length - 1]!)[0]!];
  return letters.join("").toUpperCase();
}

/**
 * Remember the display name a signed-in person presented. A name that isn't fit to show (cleanDisplayName) is
 * ignored, and an unchanged name writes nothing, so this is cheap enough to call on every studio request.
 */
export async function rememberAuthor(pool: Pick<pg.Pool, "query">, subject: string, rawName: unknown): Promise<void> {
  const name = cleanDisplayName(rawName);
  if (!name) return;
  await pool.query(
    `INSERT INTO authors (subject, display_name) VALUES ($1, $2)
     ON CONFLICT (subject) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
     WHERE authors.display_name IS DISTINCT FROM EXCLUDED.display_name`,
    [subject, name],
  );
}
