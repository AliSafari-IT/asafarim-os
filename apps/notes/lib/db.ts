/** The app's own database (created by `platform app install`): notes live here and only here. */
import pg from "pg";

const globalForDb = globalThis as unknown as { notesPool?: pg.Pool; notesSchema?: Promise<void> };

function pool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (run `pnpm platform app install notes --env-out .dev/notes.env`)");
  globalForDb.notesPool ??= new pg.Pool({ connectionString: url, max: 5 });
  return globalForDb.notesPool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id         bigserial PRIMARY KEY,
  author     text NOT NULL,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now()
)`;

/** The app's own migration, run once per process (idempotent). */
export async function db(): Promise<pg.Pool> {
  const p = pool();
  globalForDb.notesSchema ??= p.query(SCHEMA).then(() => undefined);
  await globalForDb.notesSchema;
  return p;
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

export async function createNote(author: string, title: string, body: string): Promise<Note> {
  const { rows } = await (
    await db()
  ).query<Note>("INSERT INTO notes (author, title, body) VALUES ($1, $2, $3) RETURNING *", [author, title, body]);
  return rows[0]!;
}
