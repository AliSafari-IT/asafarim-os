-- Remove backs up the app's database; purge drops it after a retention window (ADR 0001 §3 step 6).
-- Every backup a Remove took. The file is the app's database as `pg_dump --format=custom` wrote it;
-- a purge drops the database only while this file is still there with this sha256.
CREATE TABLE app_backups (
  id             bigserial PRIMARY KEY,
  app_id         text NOT NULL REFERENCES apps(id),
  database_name  text NOT NULL,
  path           text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_backups_app ON app_backups (app_id, created_at);

-- The retention clock of a removed app. Remove sets removed_at, and purge_after (removed_at plus
-- CORE_API_RETENTION_DAYS) and backup_id when the app has a database; purge sets purged_at. A reinstall
-- clears all four (it keeps the database, and the backup rows stay as history).
ALTER TABLE apps
  ADD COLUMN removed_at   timestamptz,
  ADD COLUMN purge_after  timestamptz,
  ADD COLUMN purged_at    timestamptz,
  ADD COLUMN backup_id    bigint REFERENCES app_backups(id);
