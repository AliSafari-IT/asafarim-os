-- ASafariM OS events (P4.1): the transactional outbox. Plain SQL; idempotent.
-- Same DDL as @asafarim/events OUTBOX_SQL (a test keeps them equal).
CREATE TABLE IF NOT EXISTS asafarim_outbox (
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
