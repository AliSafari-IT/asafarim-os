-- Email codes and passkeys: email becomes an identity method; passkeys get their own table
-- (a passkey is a public key, not an identifier anyone types).
ALTER TABLE identities DROP CONSTRAINT identities_method_check;
ALTER TABLE identities ADD CONSTRAINT identities_method_check CHECK (method IN ('phone', 'email'));
ALTER TABLE identities ADD CONSTRAINT identities_email_shape
  CHECK (method <> 'email' OR (identifier = lower(identifier) AND length(identifier) <= 254 AND identifier ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'));

CREATE TABLE passkeys (
  credential_id text PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9_-]{16,1400}$'),
  principal_id uuid NOT NULL REFERENCES principals (id),
  public_key jsonb NOT NULL,
  alg integer NOT NULL CHECK (alg IN (-7, -8, -257)),
  sign_count bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_principal ON passkeys (principal_id);
