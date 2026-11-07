-- Public admission (#341): a client whose policy is 'public' admits a person who proves an identifier, with no
-- admin step. Additive only: nothing existing is changed or dropped.
--
-- The access is a ROW IN ITS OWN TABLE, not a scope column on `connections`. Every earlier version reads
-- `connections` as "may use everything", so a scoped row there would, after a rollback, silently give
-- every public sign-up every restricted app. With this table, the previous version sees no connection for a
-- public-only person and refuses them (fail closed). Restricted flows, pending requests, connections and
-- suspensions are untouched.
CREATE TABLE IF NOT EXISTS client_admissions (
  principal_id uuid NOT NULL REFERENCES principals (id),
  client_id    text NOT NULL CHECK (client_id ~ '^[a-z][a-z0-9-]{1,62}$'),
  source       text NOT NULL CHECK (source IN ('public_signup')),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, client_id)
);
CREATE INDEX IF NOT EXISTS client_admissions_client ON client_admissions (client_id);

-- Where a connection row came from. NULL (every row from before) means an admin or the bootstrap.
-- 'suspension': a 'revoked' row that exists only to suspend a person who holds admissions but no connection;
-- reconnecting it deletes the row (their admissions apply again) and never makes them global.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS source text
  CHECK (source IS NULL OR source IN ('admin', 'bootstrap', 'suspension'));
