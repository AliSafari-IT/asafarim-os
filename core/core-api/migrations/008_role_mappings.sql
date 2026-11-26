-- Administrator-configured role mappings (#355, ADR 0004): whoever holds `source_role` directly also
-- holds `target_role`, as a derived grant in role_grants with granted_by = 'mapping:<id>'. Only an
-- admin writes this table. Exact roles only, never into a core role, and a role never maps to itself.
CREATE TABLE role_mappings (
  id           bigserial PRIMARY KEY,
  source_role  text NOT NULL REFERENCES roles(key),
  target_role  text NOT NULL REFERENCES roles(key),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_role, target_role),
  CHECK (source_role <> target_role),
  CHECK (target_role NOT LIKE 'core.%')
);
CREATE INDEX role_mappings_target ON role_mappings (target_role);

-- Finding a mapping's derived grants, and a subject's deliberate ones, by provenance.
CREATE INDEX role_grants_granted_by ON role_grants (granted_by) WHERE granted_by LIKE 'mapping:%';
