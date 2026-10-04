-- The dev accounts source (OS-D1, #26). It implements the same contract as
-- asafarim-platform's identity_accounts_v, so core/identity runs unchanged:
--   id, email, name, image, "isActive", roles
-- Idempotent: safe to run on every `pnpm dev`.
CREATE TABLE IF NOT EXISTS dev_users (
  id         text PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text,
  image      text,
  is_active  boolean NOT NULL DEFAULT true,
  roles      text[] NOT NULL DEFAULT '{}'
);

CREATE OR REPLACE VIEW identity_accounts_v AS
SELECT id, email, name, image, is_active AS "isActive", roles
FROM dev_users;

REVOKE ALL ON dev_users FROM identity_ro;
GRANT SELECT ON identity_accounts_v TO identity_ro;
