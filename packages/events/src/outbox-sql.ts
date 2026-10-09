/**
 * The outbox table (P4.1). The same DDL ships as `sql/001_outbox.sql` (plain SQL, the primary path)
 * and `drizzle/0000_asafarim_outbox.sql` (for a Drizzle migrations folder); a test keeps all three equal.
 *
 * Prefixed `asafarim_` so it can't collide with an app's own tables. One row per event; the relay
 * sets `sent_at` once JetStream has acknowledged it, and never deletes a row that wasn't sent.
 */
export const OUTBOX_TABLE = "asafarim_outbox";

export const OUTBOX_SQL = `CREATE TABLE IF NOT EXISTS asafarim_outbox (
  seq        bigserial PRIMARY KEY,
  id         text NOT NULL UNIQUE,
  type       text NOT NULL,
  envelope   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at    timestamptz
);
CREATE INDEX IF NOT EXISTS asafarim_outbox_pending ON asafarim_outbox (seq) WHERE sent_at IS NULL;
`;
