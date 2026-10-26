-- "Continue with Google", and access requests that say what the person wants.
--
-- Google becomes an identity method. Its identifier is Google's stable account id (`sub`), never the
-- address: an address can change hands, the id can't. `email` keeps the address Google verified, for
-- display only (the principal's label); it proves nothing on its own and is never looked up to sign in.
ALTER TABLE identities DROP CONSTRAINT identities_method_check;
ALTER TABLE identities ADD CONSTRAINT identities_method_check CHECK (method IN ('phone', 'email', 'google'));
ALTER TABLE identities ADD CONSTRAINT identities_google_subject
  CHECK (method <> 'google' OR (length(identifier) BETWEEN 1 AND 255 AND identifier ~ '^[A-Za-z0-9_-]+$'));
ALTER TABLE identities ADD COLUMN email text
  CHECK (email IS NULL OR (email = lower(email) AND length(email) <= 254 AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'));

-- A request names the apps (client ids) the person wants and may carry a short note for the admin.
-- A connected person can ask again, for more apps: the admin then grants those apps' roles.
ALTER TABLE connection_requests ADD COLUMN apps text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(apps) <= 20);
ALTER TABLE connection_requests ADD COLUMN note text CHECK (note IS NULL OR length(note) <= 500);
