import "server-only";
/**
 * Study notes (#81), in the app's own database (created by `platform app install`, DATABASE_URL). A
 * note is private: every query is scoped to its author, so someone else's note reads as "not found".
 * Without DATABASE_URL there are no notes: the reader still works and says so.
 *
 * Next to them, the event outbox (Flow, ADR 0001): creating a note, and an edit that adds the tag
 * `issue`, write `docs.note.created.v1` in the note's own transaction, so there is never a note
 * without its event or an event without its note. The relay sends the rows to the bus.
 */
import { createHash } from "node:crypto";
// Types only: the SDK's events entry (the NATS client, ajv) and the publisher (it compiles the event's
// JSON Schema) load on first use, not with every page that imports this file.
import type { Queryable, Relay } from "@asafarim/app-sdk/events";
import { databaseNameOf, traceDatabasePool } from "@asafarim/telemetry";
import pg from "pg";
import { z } from "zod";
import manifest from "../platform.app";
import type { NoteCreatedV1 } from "./events";
import { tagsOf } from "./tags";

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
CREATE INDEX IF NOT EXISTS notes_author_doc ON notes (author, doc_path);
`;

/** The tag that asks Flow to draft a GitHub issue from a note. */
export const ISSUE_TAG = "issue";

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
  /** null: no such note of this author. */
  get(author: string, id: string): Promise<Note | null>;
  create(author: string, input: z.output<typeof NoteInput> & { docSha: string }): Promise<Note>;
  /** null: no such note of this author. */
  update(author: string, id: string, body: string): Promise<Note | null>;
  remove(author: string, id: string): Promise<boolean>;
  /** The GitHub issue made from the note (#82). null: no such note of this author. */
  setIssueUrl(author: string, id: string, url: string): Promise<Note | null>;
}

const migrated = new WeakMap<pg.Pool, Promise<unknown>>();

/** The app's migrations, once per pool (idempotent); a failed run is retried on the next call. */
async function migrate(pool: pg.Pool): Promise<pg.Pool> {
  let ready = migrated.get(pool);
  if (!ready) {
    ready = import("@asafarim/app-sdk/events")
      .then(({ OUTBOX_SQL }) => pool.query(`${SCHEMA}${OUTBOX_SQL}`))
      .catch((err: unknown) => {
        migrated.delete(pool);
        throw err;
      });
    migrated.set(pool, ready);
  }
  await ready;
  return pool;
}

/** Write `docs.note.created.v1` for `note` to the outbox, through the caller's transaction. */
async function publishNoteCreated(tx: Queryable, author: string, note: Note) {
  const { NOTE_CREATED, publisher } = await import("./events");
  await publisher.publish<NoteCreatedV1>(
    tx,
    NOTE_CREATED,
    {
      id: note.id,
      author,
      docPath: note.docPath,
      tags: tagsOf(note.body),
      hasIssue: note.issueUrl !== null,
      createdAt: note.createdAt,
    },
    { subject: note.id },
  );
}

export interface NotesStoreOptions {
  /** Called after a commit (the relay's `wake`, so a new event goes out without waiting for its poll). */
  onCommit?: () => void;
}

export function createNotesStore(pool: pg.Pool, opts: NotesStoreOptions = {}): NotesStore {
  const db = () => migrate(pool);
  /** `fn` inside BEGIN … COMMIT on one connection; any error rolls everything back. */
  const inTransaction = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await (await db()).connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      opts.onCommit?.();
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
    async get(author, id) {
      const { rows } = await (
        await db()
      ).query<Row>(`SELECT ${COLUMNS} FROM notes WHERE id = $2 AND author = $1`, [author, id]);
      return rows[0] ? toNote(rows[0]) : null;
    },
    // Every new note publishes docs.note.created.v1, in the insert's transaction.
    async create(author, n) {
      return inTransaction(async (client) => {
        const { rows } = await client.query<Row>(
          `INSERT INTO notes (author, doc_path, heading_id, quote, body, doc_sha) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${COLUMNS}`,
          [author, n.docPath, n.headingId, n.quote, n.body, n.docSha],
        );
        const note = toNote(rows[0]!);
        await publishNoteCreated(client, author, note);
        return note;
      });
    },
    // An edit publishes it again only when it adds the tag `issue` (the row is locked between the read and the write).
    async update(author, id, body) {
      return inTransaction(async (client) => {
        const before = await client.query<{ body: string }>(
          "SELECT body FROM notes WHERE id = $2 AND author = $1 FOR UPDATE",
          [author, id],
        );
        if (!before.rows[0]) return null;
        const hadIssueTag = tagsOf(before.rows[0].body).includes(ISSUE_TAG);
        const { rows } = await client.query<Row>(
          `UPDATE notes SET body = $3, updated_at = now() WHERE id = $2 AND author = $1 RETURNING ${COLUMNS}`,
          [author, id, body],
        );
        const note = toNote(rows[0]!);
        if (!hadIssueTag && tagsOf(note.body).includes(ISSUE_TAG)) {
          await publishNoteCreated(client, author, note);
        }
        return note;
      });
    },
    async remove(author, id) {
      const res = await (await db()).query("DELETE FROM notes WHERE id = $2 AND author = $1", [author, id]);
      return (res.rowCount ?? 0) > 0;
    },
    async setIssueUrl(author, id, url) {
      const { rows } = await (
        await db()
      ).query<Row>(
        `UPDATE notes SET issue_url = $3, updated_at = now() WHERE id = $2 AND author = $1 RETURNING ${COLUMNS}`,
        [author, id, url],
      );
      return rows[0] ? toNote(rows[0]) : null;
    },
  };
}

const g = globalThis as unknown as {
  docsPool?: pg.Pool | null;
  docsNotes?: NotesStore | null;
  docsRelay?: Relay | null;
};

/** The app's pool, one per server process; null without DATABASE_URL. */
function docsPool(): pg.Pool | null {
  if (g.docsPool === undefined) {
    const url = process.env.DATABASE_URL;
    g.docsPool = url ? createDocsPool(url) : null;
  }
  return g.docsPool;
}

/** The app's notes; null without DATABASE_URL. */
export function getNotes(): NotesStore | null {
  if (g.docsNotes === undefined) {
    const pool = docsPool();
    g.docsNotes = pool ? createNotesStore(pool, { onCommit: () => g.docsRelay?.wake() }) : null;
  }
  return g.docsNotes;
}

/**
 * Start the outbox relay once per process (on boot: instrumentation.ts), so events left in the
 * outbox by an earlier run go out too. Without DATABASE_URL or ASAFARIM_NATS_URL there is none.
 */
export async function startEventRelay(): Promise<Relay | undefined> {
  if (g.docsRelay === undefined) {
    const pool = docsPool();
    const { startAppRelay } = await import("@asafarim/app-sdk/events");
    g.docsRelay ??= pool ? (startAppRelay({ appId: manifest.id, pool: () => migrate(pool) }) ?? null) : null;
  }
  return g.docsRelay ?? undefined;
}

/**
 * The app's pool. Each query inside a traced request is a CLIENT span (P6, ADR 0001 §9): the
 * operation, the database name and, on failure, the SQLSTATE; never the SQL text or its parameters
 * (study notes are personal). Nothing is traced with telemetry off. Connecting is lazy.
 */
export function createDocsPool(url: string): pg.Pool {
  const pool = traceDatabasePool(new pg.Pool({ connectionString: url, max: 5 }), { namespace: databaseNameOf(url) });
  // An idle connection dropped by the server is reported on the pool; unhandled, it would crash
  // the process. The pool replaces it on the next query.
  pool.on("error", (err) =>
    console.warn(JSON.stringify({ app: "docs", level: "warn", msg: "db.idle_connection_lost", error: err.message })),
  );
  return pool;
}
