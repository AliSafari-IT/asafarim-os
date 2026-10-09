-- ASafariM OS events (P4.1): the consumer inbox (dedupe on the event id), for a Drizzle migrations folder.
-- Same DDL as @asafarim/events INBOX_SQL (a test keeps them equal).
CREATE TABLE IF NOT EXISTS asafarim_inbox (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
