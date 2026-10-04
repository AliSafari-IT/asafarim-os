-- core-api's database (P3.1, ADR 0001 §3–4). Applied in order at startup;
-- each file runs once (schema_migrations).

CREATE TABLE apps (
  id             text PRIMARY KEY,
  version        text NOT NULL,
  manifest       jsonb NOT NULL,
  state          text NOT NULL CHECK (state IN ('installed', 'active', 'inactive', 'removed')),
  database_name  text NOT NULL,
  installed_at   timestamptz NOT NULL DEFAULT now(),
  registered_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The app's registry credential. Only what's needed to VERIFY is stored
-- (see src/credentials.ts); the signing secret is shown once at install.
CREATE TABLE app_credentials (
  key_id      text PRIMARY KEY,
  app_id      text NOT NULL REFERENCES apps(id),
  scheme      text NOT NULL,
  verifier    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX app_credentials_app ON app_credentials (app_id) WHERE revoked_at IS NULL;

-- Permissions and roles are DECLARED by apps (inside their own namespace).
-- Removed ones are deprecated, never deleted by registration.
CREATE TABLE permissions (
  key            text PRIMARY KEY,
  app_id         text NOT NULL REFERENCES apps(id),
  description    text NOT NULL,
  deprecated_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  key            text PRIMARY KEY,
  app_id         text NOT NULL REFERENCES apps(id),
  description    text,
  deprecated_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_key        text NOT NULL REFERENCES roles(key),
  permission_key  text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_key, permission_key)
);

-- Who holds a role. Written ONLY by admin actions, never by registration.
CREATE TABLE role_grants (
  role_key    text NOT NULL REFERENCES roles(key),
  subject     text NOT NULL,
  granted_by  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, subject)
);

CREATE TABLE event_subscriptions (
  app_id      text NOT NULL REFERENCES apps(id),
  event_type  text NOT NULL,
  handler     text NOT NULL,
  PRIMARY KEY (app_id, event_type)
);

CREATE TABLE audit_events (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  app_id  text,
  detail  jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_app ON audit_events (app_id, at);

-- Single-use registration nonces (replay cache), pruned after they expire.
CREATE TABLE registry_nonces (
  nonce       text PRIMARY KEY,
  app_id      text NOT NULL,
  expires_at  timestamptz NOT NULL
);
