-- core-api's own catalog (P3.3b, ADR 0001 §4): the platform's built-in "app" `core`,
-- with the one permission and role that gate the Admin console and the admin API.
-- It is not installed, registered or deactivated like an app (ids like `core` are reserved
-- for the platform): a migration defines it, so `platform role grant core.admin <sub>`
-- works on a fresh database. Only an admin grants the role; nothing self-grants it.

-- A built-in app has no database of its own (and an app whose manifest says engine "none" won't get one).
ALTER TABLE apps ALTER COLUMN database_name DROP NOT NULL;

INSERT INTO apps (id, version, manifest, state, database_name, registered_at)
VALUES ('core', '0.1.0', '{"id": "core", "name": "Core", "system": true}', 'active', NULL, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (key, app_id, description)
VALUES ('core.admin', 'core', 'Administer the platform: apps, roles and grants, the audit log')
ON CONFLICT (key) DO NOTHING;

INSERT INTO roles (key, app_id, description)
VALUES ('core.admin', 'core', 'Platform administrator')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_key, permission_key)
VALUES ('core.admin', 'core.admin')
ON CONFLICT DO NOTHING;
