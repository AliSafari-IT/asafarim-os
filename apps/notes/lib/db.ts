/**
 * The app's own database (created by `platform app install`): notes live here and only here, next to
 * the event outbox (P4.1) whose rows the relay sends to the bus.
 */
import { OUTBOX_SQL, startAppRelay, type Relay } from "@asafarim/app-sdk/events";
import pg from "pg";
import manifest from "../platform.app";
import { NOTE_CREATED, publisher, type NoteCreatedV1 } from "./events";

const globalForDb = globalThis as unknown as {
  notesPool?: pg.Pool;
  notesSchema?: Promise<void>;
  notesRelay?: Relay | null;
};

function pool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (run `pnpm platform app install notes --env-out .dev/notes.env`)");
  if (!globalForDb.notesPool) {
    globalForDb.notesPool = new pg.Pool({ connectionString: url, max: 5 });
    // An idle connection dropped by the server (a restart, an admin terminating it) is reported on
    // the pool; unhandled, it would crash the process. The pool replaces it on the next query.
    globalForDb.notesPool.on("error", (err) =>
      console.warn(JSON.stringify({ app: "notes", level: "warn", msg: "db.idle_connection_lost", error: err.message })),
    );
  }
  return globalForDb.notesPool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id         bigserial PRIMARY KEY,
  author     text NOT NULL,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
${OUTBOX_SQL}`;

/** The app's own migrations, run once per process (idempotent). A failed run is retried on the next call. */
export async function db(): Promise<pg.Pool> {
  const p = pool();
  globalForDb.notesSchema ??= p.query(SCHEMA).then(
    () => undefined,
    (err: unknown) => {
      globalForDb.notesSchema = undefined;
      throw err;
    },
  );
  await globalForDb.notesSchema;
  return p;
}

/**
 * Start the outbox relay once per process (on boot: instrumentation.ts), so events left in the
 * outbox by an earlier run go out too. Without ASAFARIM_NATS_URL there is no relay (logged once).
 */
export function startEventRelay(): Relay | undefined {
  if (globalForDb.notesRelay === undefined) {
    globalForDb.notesRelay = startAppRelay({ appId: manifest.id, pool: () => db() }) ?? null;
  }
  return globalForDb.notesRelay ?? undefined;
}

export interface Note {
  id: string;
  author: string;
  title: string;
  body: string;
  created_at: Date;
}

export async function listNotes(limit: number): Promise<Note[]> {
  const { rows } = await (await db()).query<Note>("SELECT * FROM notes ORDER BY id DESC LIMIT $1", [limit]);
  return rows;
}

export async function countNotes(): Promise<number> {
  const { rows } = await (await db()).query<{ n: string }>("SELECT count(*) AS n FROM notes");
  return Number(rows[0]!.n);
}

/** Insert the note and publish notes.note.created.v1 in ONE transaction: both happen, or neither. */
export async function createNote(author: string, title: string, body: string): Promise<Note> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Note>(
      "INSERT INTO notes (author, title, body) VALUES ($1, $2, $3) RETURNING *",
      [author, title, body],
    );
    const note = rows[0]!;
    await publisher.publish<NoteCreatedV1>(
      client,
      NOTE_CREATED,
      { id: String(note.id), author: note.author, title: note.title, createdAt: note.created_at.toISOString() },
      { subject: String(note.id) },
    );
    await client.query("COMMIT");
    globalForDb.notesRelay?.wake();
    return note;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
