/**
 * Knowledge's own migrations, in order (the SQL pattern of apps/flow). Each runs once, recorded in
 * `knowledge_migrations`, all under one advisory lock so two instances starting at once can't run them
 * twice. Never edit one that has shipped: add the next.
 */

export const MIGRATIONS: readonly { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "content items, immutable revisions and the audit log (Phase 0)",
    sql: `
-- One article (later: doc entry, video). Who owns it, its public address and two pointers: the draft
-- head (the newest saved revision) and the published revision (NULL = nothing public).
CREATE TABLE content_items (
  id                    text PRIMARY KEY,
  kind                  text NOT NULL DEFAULT 'article' CHECK (kind IN ('article')),
  owner_subject         text NOT NULL,
  slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 96),
  language              text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}$'),
  draft_revision_id     text,
  published_revision_id text,
  published_at          timestamptz,
  withdrawn_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_items_owner ON content_items (owner_subject, updated_at DESC);
CREATE INDEX content_items_published ON content_items (published_at DESC) WHERE published_revision_id IS NOT NULL;

-- Immutable: a save is a new revision. A published page is always exactly one of these.
CREATE TABLE content_revisions (
  id         text PRIMARY KEY,
  item_id    text NOT NULL REFERENCES content_items (id),
  number     integer NOT NULL CHECK (number >= 1),
  format     text NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown')),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary    text NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 200000),
  author     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, number),
  -- So an item's pointers can only ever name one of its own revisions (the composite FKs below).
  UNIQUE (item_id, id)
);
CREATE FUNCTION knowledge_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'content_revisions are immutable: save a new revision';
END $$;
CREATE TRIGGER content_revisions_immutable BEFORE UPDATE OR DELETE ON content_revisions
  FOR EACH ROW EXECUTE FUNCTION knowledge_revisions_immutable();

ALTER TABLE content_items
  ADD CONSTRAINT content_items_draft_fk FOREIGN KEY (id, draft_revision_id)
    REFERENCES content_revisions (item_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT content_items_published_fk FOREIGN KEY (id, published_revision_id)
    REFERENCES content_revisions (item_id, id),
  -- Published and withdrawn are exclusive states of the public pointer.
  ADD CONSTRAINT content_items_publication CHECK (
    (published_revision_id IS NULL OR (published_at IS NOT NULL AND withdrawn_at IS NULL))
  );

-- Who did what to which item: identifiers only, never a draft's text.
CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL CHECK (action IN ('content.created', 'content.saved', 'content.published', 'content.withdrawn')),
  item_id     text NOT NULL REFERENCES content_items (id),
  revision_id text
);
CREATE INDEX audit_events_item ON audit_events (item_id, at);`,
  },
];

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Apply every migration not yet recorded, in one transaction under the advisory lock. Returns the versions applied. */
export async function migrate(client: Queryable): Promise<number[]> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('knowledge.migrations'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS knowledge_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query("SELECT version FROM knowledge_migrations")).rows.map((r) => r.version as number),
    );
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query(m.sql);
      await client.query("INSERT INTO knowledge_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
      applied.push(m.version);
    }
    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
