-- 002's credential_id check used '{16,1400}', but Postgres caps a regex repetition count at 255
-- (RE_DUP_MAX). The table was created (a CHECK's regex compiles on first use), and then every
-- INSERT into passkeys failed with "invalid regular expression: invalid repetition count(s)".
-- Same rule, length checked apart from the character class. 002 stays unchanged: it may already
-- be applied, and migrations run once each.
ALTER TABLE passkeys DROP CONSTRAINT IF EXISTS passkeys_credential_id_check;
ALTER TABLE passkeys ADD CONSTRAINT passkeys_credential_id_check
  CHECK (length(credential_id) BETWEEN 16 AND 1400 AND credential_id ~ '^[A-Za-z0-9_-]+$');
