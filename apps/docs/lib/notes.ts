import "server-only";
/**
 * Study notes (#81), in the app's own database (created by `platform app install`, DATABASE_URL). A
 * note is private: every query is scoped to its author, so someone else's note reads as "not found".
 * Without DATABASE_URL there are no notes: the reader still works and says so.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { z } from "zod";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id         bigserial PRIMARY KEY,
  author     text NOT NULL,
  doc_path   text NOT NULL CHECK (length(doc_path) BETWEEN 1 AND 500),
  heading_id text NOT NULL DEFAULT '' CHECK (length(heading_id) <= 200),
  quote      text NOT NULL DEFAULT '' CHECK (length(quote) <= 1000),
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  doc_sha    text NOT NULL CHECK (length(doc_sha) = 64),
  issue_url  text CHECK (issue_url IS NULL OR length(issue_url) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_author_doc ON notes (author, doc_path);`;

export interface Note {
  id: string;
  docPath: string;
  headingId: string;
  /** The selected text, plain text: shown as text, never as HTML. */
  quote: string;
  /** Markdown, rendered like a document (sanitized first). */
  body: string;
  /** The version of the document the note was written on (sha-256 of its Markdown). */
  docSha: string;
  issueUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  doc_path: string;
  heading_id: string;
  quote: string;
  body: string;
  doc_sha: string;
  issue_url: string | null;
  created_at: Date;
  updated_at: Date;
}

const toNote = (r: Row): Note => ({
  id: String(r.id),
  docPath: r.doc_path,
  headingId: r.heading_id,
  quote: r.quote,
  body: r.body,
  docSha: r.doc_sha,
  issueUrl: r.issue_url,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const COLUMNS = "id, doc_path, heading_id, quote, body, doc_sha, issue_url, created_at, updated_at";

/** The version of a document a note is written on. */
export const docShaOf = (markdown: string) => createHash("sha256").update(markdown).digest("hex");

/** What a request may send. The doc and heading are checked against the document by the route. */
export const NoteInput = z.object({
  docPath: z.string().min(1).max(500),
  headingId: z.string().max(200).default(""),
  quote: z
    .string()
    .max(1000)
    .default("")
    .transform((q) => q.replace(/\s+/g, " ").trim()),
  body: z.string().trim().min(1).max(10_000),
});
export const NoteEdit = z.object({ body: z.string().trim().min(1).max(10_000) });

/** A note id from a URL: digits only, or nothing (so a bad id is a 404, never a database error). */
export const noteId = (raw: string) => (/^[1-9]\d{0,17}$/.test(raw) ? raw : undefined);

export interface NotesStore {
  list(author: string, docPath?: string): Promise<Note[]>;
  create(author: string, input: z.output<typeof NoteInput> & { docSha: string }): Promise<Note>;
  /** null: no such note of this author. */
  update(author: string, id: string, body: string): Promise<Note | null>;
  remove(author: string, id: string): Promise<boolean>;
}

export function createNotesStore(pool: pg.Pool): NotesStore {
  let ready: Promise<unknown> | undefined;
  // The app's migration, once per process (idempotent); a failed run is retried on the next call.
  const db = async () => {
    ready ??= pool.query(SCHEMA).catch((err: unknown) => {
      ready = undefined;
      throw err;
    });
    await ready;
    return pool;
  };
  return {
    async list(author, docPath) {
      const { rows } = await (
        await db()
      ).query<Row>(
        `SELECT ${COLUMNS} FROM notes WHERE author = $1 AND ($2::text IS NULL OR doc_path = $2) ORDER BY doc_path, id`,
        [author, docPath ?? null],
      );
      return rows.map(toNote);
    },
    async create(author, n) {
      const { rows } = await (
        await db()
      ).query<Row>(
        `INSERT INTO notes (author, doc_path, heading_id, quote, body, doc_sha) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [author, n.docPath, n.headingId, n.quote, n.body, n.docSha],
      );
      return toNote(rows[0]!);
    },
    async update(author, id, body) {
      const { rows } = await (
        await db()
      ).query<Row>(
        `UPDATE notes SET body = $3, updated_at = now() WHERE id = $2 AND author = $1 RETURNING ${COLUMNS}`,
        [author, id, body],
      );
      return rows[0] ? toNote(rows[0]) : null;
    },
    async remove(author, id) {
      const res = await (await db()).query("DELETE FROM notes WHERE id = $2 AND author = $1", [author, id]);
      return (res.rowCount ?? 0) > 0;
    },
  };
}

const g = globalThis as unknown as { docsNotes?: NotesStore | null };

/** The app's notes, one pool per server process; null without DATABASE_URL. */
export function getNotes(): NotesStore | null {
  if (g.docsNotes === undefined) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      g.docsNotes = null;
    } else {
      const pool = new pg.Pool({ connectionString: url, max: 5 });
      // An idle connection dropped by the server is reported on the pool; unhandled, it would crash
      // the process. The pool replaces it on the next query.
      pool.on("error", (err) =>
        console.warn(
          JSON.stringify({ app: "docs", level: "warn", msg: "db.idle_connection_lost", error: err.message }),
        ),
      );
      g.docsNotes = createNotesStore(pool);
    }
  }
  return g.docsNotes;
}
