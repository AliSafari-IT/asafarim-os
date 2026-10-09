/**
 * The inbox table (P4.1): one row per event a consuming app has processed, keyed by the event id.
 * The subscriber inserts the row in the SAME transaction as the handler's own writes, so a
 * redelivered event (same id) finds its row and is acked without calling the handler again.
 *
 * The same DDL ships as `sql/002_inbox.sql` (plain SQL, the primary path) and
 * `drizzle/0001_asafarim_inbox.sql` (for a Drizzle migrations folder); a test keeps all three equal.
 * Prefixed `asafarim_` so it can't collide with an app's own tables.
 */
export const INBOX_TABLE = "asafarim_inbox";

export const INBOX_SQL = `CREATE TABLE IF NOT EXISTS asafarim_inbox (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
`;
