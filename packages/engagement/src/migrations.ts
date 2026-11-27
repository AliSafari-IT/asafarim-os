/**
 * The engagement schema, created inside the HOST APP's own database (never shared between apps).
 *
 * `migrateEngagement(client)` is idempotent and safe with several instances starting at once: it takes a
 * transaction-scoped advisory lock, applies the migrations that `engagement_migrations` has not recorded, and
 * records them. An app whose own migration runner prefers to embed the SQL can use `ENGAGEMENT_MIGRATIONS`.
 * Never edit a migration that has shipped: append the next one.
 *
 * Identifiers: `entity_id` and `user_id` are text (the OIDC `sub` and the apps' own ids are text), not uuid.
 */

export interface EngagementMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const ENGAGEMENT_MIGRATIONS: readonly EngagementMigration[] = [
  {
    version: 1,
    name: "likes and comments on any entity",
    sql: `
-- One like. Exactly one actor: a signed-in user (OIDC sub) or a guest (keyed visitor hash).
CREATE TABLE engagement_likes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  varchar(50) NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,49}$'),
  entity_id    text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 128),
  user_id      text CHECK (length(user_id) BETWEEN 1 AND 256),
  visitor_hash varchar(64) CHECK (visitor_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_likes_one_actor CHECK (num_nonnulls(user_id, visitor_hash) = 1)
);
CREATE UNIQUE INDEX engagement_likes_user_uq
  ON engagement_likes (entity_type, entity_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX engagement_likes_visitor_uq
  ON engagement_likes (entity_type, entity_id, visitor_hash) WHERE user_id IS NULL;
CREATE INDEX engagement_likes_entity ON engagement_likes (entity_type, entity_id);
CREATE INDEX engagement_likes_user ON engagement_likes (user_id) WHERE user_id IS NOT NULL;

-- One comment. Guests cannot comment (user_id NOT NULL). author_snapshot is written with the comment so showing a
-- thread never needs a call to core/identity: { "name": …, "avatar_url": …, "role": … }.
CREATE TABLE engagement_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     varchar(50) NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,49}$'),
  entity_id       text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 128),
  user_id         text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  author_snapshot jsonb NOT NULL,
  parent_id       uuid REFERENCES engagement_comments (id) ON DELETE CASCADE,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  is_pinned       boolean NOT NULL DEFAULT false,
  status          varchar(20) NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engagement_comments_entity ON engagement_comments (entity_type, entity_id, created_at);
CREATE INDEX engagement_comments_parent ON engagement_comments (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX engagement_comments_user ON engagement_comments (user_id);

-- Replies are one level deep, and a reply belongs to the same entity as its parent.
CREATE FUNCTION engagement_comment_parent_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT parent_id, entity_type, entity_id INTO p FROM engagement_comments WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports it
  END IF;
  IF p.parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'replies can only be one level deep' USING ERRCODE = 'check_violation';
  END IF;
  IF p.entity_type <> NEW.entity_type OR p.entity_id <> NEW.entity_id THEN
    RAISE EXCEPTION 'a reply must belong to the same entity as its parent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER engagement_comments_parent_check
  BEFORE INSERT OR UPDATE OF parent_id, entity_type, entity_id ON engagement_comments
  FOR EACH ROW EXECUTE FUNCTION engagement_comment_parent_check();`,
  },
];

/** One lock key for every app's engagement migration (each app has its own database, so no cross-app contention). */
const ADVISORY_LOCK_KEY = 7_240_513;

/** The slice of a `pg` client this needs (a PoolClient, or a Client). It must NOT already be inside a transaction. */
export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Apply the engagement migrations that have not run yet. Returns the versions applied by this call. */
export async function migrateEngagement(client: MigrationClient): Promise<number[]> {
  await client.query("BEGIN");
  try {
    // Lock first: two instances starting together must not race on creating the bookkeeping table either.
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS engagement_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query("SELECT version FROM engagement_migrations")).rows.map((r) => Number(r.version)),
    );
    const applied: number[] = [];
    for (const m of ENGAGEMENT_MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query(m.sql);
      await client.query("INSERT INTO engagement_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
      applied.push(m.version);
    }
    await client.query("COMMIT");
    return applied;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
