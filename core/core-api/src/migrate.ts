/** Apply migrations/*.sql in name order, each once, in a transaction (schema_migrations). */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

const DIR = path.join(import.meta.dirname, "../migrations");

export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );
    for (const file of readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (done.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(path.join(DIR, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
  return applied;
}
