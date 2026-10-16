-- The identity service's own data (the SMS sign-in method).
--
-- Authentication and authorization are kept apart:
--   identities   how a person proves who they are (method + identifier; today only 'phone').
--                More methods (email, passkey, ...) add rows here, not new principal columns.
--   connections  whether that person may use ASafariM. A verified identity alone grants nothing.
--
-- Phone numbers are stored in E.164 form only; codes are never stored here (Redis holds an HMAC).

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
  method text NOT NULL CHECK (method IN ('phone')),
  identifier text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals (id),
  -- NULL until the person proves it (an admin may add a number before its first sign-in).
  verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (method, identifier),
  CONSTRAINT identities_phone_e164 CHECK (method <> 'phone' OR identifier ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE INDEX identities_principal ON identities (principal_id);

CREATE TABLE connections (
  principal_id uuid PRIMARY KEY REFERENCES principals (id),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  -- NULL: granted by the bootstrap (IDENTITY_BOOTSTRAP_ADMIN_PHONE), not by a person.
  granted_by uuid REFERENCES principals (id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES principals (id),
  CONSTRAINT connections_revoked_consistent CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principals (id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES principals (id),
  CONSTRAINT connection_requests_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- At most one open request per person.
CREATE UNIQUE INDEX connection_requests_one_pending ON connection_requests (principal_id) WHERE status = 'pending';

-- Append-only: every sign-in attempt and every admin decision. No plaintext numbers or addresses:
-- attempts by someone not yet proved are keyed by an HMAC (subject_handle), IPs likewise (ip_handle).
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  method text,
  principal_id uuid,
  actor_id uuid,
  subject_handle text,
  ip_handle text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_principal ON audit_log (principal_id, at DESC);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
