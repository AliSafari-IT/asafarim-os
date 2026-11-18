/**
 * The app's own database (created by `platform app install knowledge`): articles and their revisions.
 * On first use it runs the migrations, once per process.
 */
import { databaseNameOf, traceDatabasePool } from "@asafarim/telemetry";
import pg from "pg";
import { migrate } from "./migrations";

const globalForDb = globalThis as unknown as { knowledgePool?: pg.Pool; knowledgeSchema?: Promise<void> };

function pool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (run `pnpm platform app install knowledge --env-out .dev/knowledge.env`)");
  }
  globalForDb.knowledgePool ??= createKnowledgePool(url);
  return globalForDb.knowledgePool;
}

/**
 * The app's pool. Each query inside a traced request is a CLIENT span: the operation, the database name
 * and, on failure, the SQLSTATE; never the SQL text or its parameters. Connecting is lazy.
 */
export function createKnowledgePool(url: string): pg.Pool {
  const p = traceDatabasePool(new pg.Pool({ connectionString: url, max: 5 }), { namespace: databaseNameOf(url) });
  // An idle connection dropped by the server is reported on the pool; unhandled, it would crash the process.
  p.on("error", (err) =>
    console.warn(
      JSON.stringify({ app: "knowledge", level: "warn", msg: "db.idle_connection_lost", error: err.message }),
    ),
  );
  return p;
}

/** Migrate `p` (idempotent; safe with several instances). */
export async function prepare(p: pg.Pool): Promise<number[]> {
  const client = await p.connect();
  try {
    return await migrate(client);
  } finally {
    client.release();
  }
}

/** The pool, migrated (once per process; a failed run is retried on the next call). */
export async function db(): Promise<pg.Pool> {
  const p = pool();
  globalForDb.knowledgeSchema ??= prepare(p).then(
    () => undefined,
    (err: unknown) => {
      globalForDb.knowledgeSchema = undefined;
      throw err;
    },
  );
  await globalForDb.knowledgeSchema;
  return p;
}
