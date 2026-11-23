/**
 * Knowledge's own migrations, in order (the SQL pattern of apps/flow). Each runs once, recorded in
 * `knowledge_migrations`, all under one advisory lock so two instances starting at once can't run them
 * twice. Never edit one that has shipped: add the next. A migration may also run `after` (TypeScript, in the same
 * transaction, after its SQL) when the data it needs is built in code, like the search projection.
 */
import { refreshSearchDocument } from "./search-index";

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Index every article that was already public before search existed (#357), from its published revision. */
export async function backfillSearch(client: Queryable): Promise<void> {
  const { rows } = await client.query(
    "SELECT id FROM content_items WHERE published_revision_id IS NOT NULL ORDER BY id FOR UPDATE",
  );
  for (const r of rows)
    await refreshSearchDocument(client as Parameters<typeof refreshSearchDocument>[0], String(r.id));
}

export const MIGRATIONS: readonly {
  version: number;
  name: string;
  sql: string;
  after?: (client: Queryable) => Promise<void>;
}[] = [
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
  {
    version: 2,
    name: "structured revisions: Tiptap JSON documents next to Phase 0 Markdown (#356)",
    sql: `
-- A revision is either Phase 0 Markdown (body) or a validated Tiptap document (doc, with its schema version; body is
-- then the document's plain text, for search and summaries). Existing rows stay Markdown.
ALTER TABLE content_revisions DROP CONSTRAINT content_revisions_format_check;
ALTER TABLE content_revisions
  ADD COLUMN doc jsonb,
  ADD COLUMN schema_version integer,
  ADD CONSTRAINT content_revisions_format_check CHECK (format IN ('markdown', 'tiptap')),
  ADD CONSTRAINT content_revisions_doc_matches_format CHECK (
    (format = 'tiptap' AND doc IS NOT NULL AND schema_version IS NOT NULL AND jsonb_typeof(doc) = 'object')
    OR (format = 'markdown' AND doc IS NULL AND schema_version IS NULL)
  );`,
  },
  {
    version: 3,
    name: "AI writing assistance: token budgets and a job log without prompts or answers (#360)",
    sql: `
-- Tokens reserved and used per calendar month (UTC), for the whole publication (subject '*') and per author.
-- A request reserves its worst case first (in one transaction with the cap check), then settles to what it used.
CREATE TABLE ai_usage (
  month    text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  subject  text NOT NULL,
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  used     bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (month, subject)
);

-- One row per AI request: who, what, on which article and revision, the outcome and the tokens. Never the prompt,
-- the selected text or the answer.
CREATE TABLE ai_jobs (
  id               text PRIMARY KEY,
  actor            text NOT NULL,
  operation        text NOT NULL CHECK (operation IN ('outline', 'improve', 'summary', 'mermaid')),
  item_id          text NOT NULL REFERENCES content_items (id),
  base_revision_id text NOT NULL,
  status           text NOT NULL CHECK (status IN ('succeeded', 'failed', 'refused', 'over_budget')),
  error_code       text,
  model            text,
  input_tokens     integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_jobs_actor ON ai_jobs (actor, created_at DESC);`,
  },
  {
    version: 4,
    name: "durable AI token reservations",
    sql: `
CREATE TABLE ai_reservations (
  id uuid PRIMARY KEY,
  month text NOT NULL,
  subject text NOT NULL,
  tokens bigint NOT NULL CHECK (tokens > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  charged bigint CHECK (charged >= 0),
  FOREIGN KEY (month, subject) REFERENCES ai_usage (month, subject)
);
CREATE INDEX ai_reservations_pending ON ai_reservations (created_at) WHERE charged IS NULL;`,
  },
  {
    version: 5,
    name: "autosaves, slug redirects and slug-change audit (#372)",
    sql: `
-- The editor's unsaved text, one row per article and author, overwritten on every autosave. Never a revision and
-- never public: it keeps work safe between saves and after a conflict. base_revision_id is the revision the editor
-- opened (one of this article's own, by the composite key); an explicit save deletes the row.
CREATE TABLE draft_autosaves (
  item_id          text NOT NULL REFERENCES content_items (id),
  author           text NOT NULL,
  base_revision_id text NOT NULL,
  title            text NOT NULL CHECK (length(title) <= 200),
  summary          text NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
  doc              jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object'),
  body             text NOT NULL DEFAULT '' CHECK (length(body) <= 200000),
  saved_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, author),
  FOREIGN KEY (item_id, base_revision_id) REFERENCES content_revisions (item_id, id)
);

-- Old public addresses of an article. Each names the article, not another slug, so a redirect always leads to the
-- article's current slug in one hop and can't form a chain or a cycle. An old slug is never any article's current
-- slug (lib/content.ts keeps that inside the transaction that changes or claims a slug).
CREATE TABLE slug_redirects (
  old_slug   text PRIMARY KEY CHECK (old_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(old_slug) <= 96),
  item_id    text NOT NULL REFERENCES content_items (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slug_redirects_item ON slug_redirects (item_id);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (
  action IN ('content.created', 'content.saved', 'content.published', 'content.withdrawn', 'content.slug_changed')
);`,
  },
  {
    version: 6,
    name: "topics, curated tags and the public search projection (#357)",
    sql: `
-- Trigram similarity for misspelled titles and tags. A trusted extension: the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A small hierarchy: a topic is top level or the child of a top-level topic (lib/taxonomy.ts keeps it two deep).
CREATE TABLE topics (
  id          text PRIMARY KEY,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 64),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  parent_id   text REFERENCES topics (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Curated tags: only an editor creates them; authors pick from them. 'technology' tags are the technology facet.
CREATE TABLE tags (
  id         text PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 64),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind       text NOT NULL DEFAULT 'subject' CHECK (kind IN ('subject', 'technology')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tags_name_trgm ON tags USING gin (lower(name) gin_trgm_ops);
-- Other spellings that resolve to a tag (js -> javascript, c-sharp -> csharp). Lower-case, never a tag's own slug.
CREATE TABLE tag_aliases (
  alias  text PRIMARY KEY CHECK (alias = lower(alias) AND length(alias) BETWEEN 1 AND 60),
  tag_id text NOT NULL REFERENCES tags (id) ON DELETE CASCADE
);

-- An article's classification, set in the studio. Public only through the projection below.
ALTER TABLE content_items
  ADD COLUMN topic_id text REFERENCES topics (id),
  ADD COLUMN level text CHECK (level IN ('beginner', 'intermediate', 'advanced'));
CREATE TABLE item_tags (
  item_id text NOT NULL REFERENCES content_items (id),
  tag_id  text NOT NULL REFERENCES tags (id),
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX item_tags_tag ON item_tags (tag_id);

-- The public search projection: one row per PUBLISHED article, written in the same transaction that publishes,
-- withdraws, moves or reclassifies it (lib/search-index.ts), deleted on withdrawal. Search reads only this, so a
-- draft or withdrawn article can't appear in results.
CREATE TABLE search_documents (
  item_id      text PRIMARY KEY REFERENCES content_items (id),
  revision_id  text NOT NULL,
  slug         text NOT NULL,
  kind         text NOT NULL,
  language     text NOT NULL,
  topic_id     text REFERENCES topics (id),
  level        text,
  tag_ids      text[] NOT NULL DEFAULT '{}',
  title        text NOT NULL,
  summary      text NOT NULL,
  published_at timestamptz NOT NULL,
  -- Weighted: title A, tags and headings B, summary C, body D. 'simple': no stemming, so identifiers stay whole.
  tsv          tsvector NOT NULL,
  FOREIGN KEY (item_id, revision_id) REFERENCES content_revisions (item_id, id)
);
CREATE INDEX search_documents_tsv ON search_documents USING gin (tsv);
CREATE INDEX search_documents_title_trgm ON search_documents USING gin (lower(title) gin_trgm_ops);
CREATE INDEX search_documents_tags ON search_documents USING gin (tag_ids);
CREATE INDEX search_documents_topic ON search_documents (topic_id, published_at DESC);

-- Identifiers found in the article (useEffect, err_connection_reset, c#), lower-cased, for exact and prefix matches.
CREATE TABLE search_terms (
  item_id text NOT NULL REFERENCES search_documents (item_id) ON DELETE CASCADE,
  term    text NOT NULL,
  PRIMARY KEY (term, item_id)
);
CREATE INDEX search_terms_prefix ON search_terms (term text_pattern_ops);
CREATE INDEX search_terms_item ON search_terms (item_id);

-- The article split at its headings, for snippets that link to the section that matched.
CREATE TABLE search_sections (
  item_id  text NOT NULL REFERENCES search_documents (item_id) ON DELETE CASCADE,
  position integer NOT NULL,
  anchor   text,
  heading  text NOT NULL DEFAULT '',
  body     text NOT NULL,
  tsv      tsvector NOT NULL,
  PRIMARY KEY (item_id, position)
);`,
    after: backfillSearch,
  },
  {
    version: 7,
    name: "courses: immutable revisions of ordered lessons pinned to article revisions (#358)",
    sql: `
-- A course has the same two pointers as an article: the draft head and the published revision (NULL = not public).
-- Its slug is its own namespace (/courses/:slug).
CREATE TABLE courses (
  id                    text PRIMARY KEY,
  owner_subject         text NOT NULL,
  slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 96),
  draft_revision_id     text,
  published_revision_id text,
  published_at          timestamptz,
  withdrawn_at          timestamptz,
  -- Counts publishes and withdrawals, so a studio form names the publication state it showed and a stale one is
  -- refused even after a publish/withdraw cycle that put the pointers back where they were.
  publication           integer NOT NULL DEFAULT 0 CHECK (publication >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courses_owner ON courses (owner_subject, updated_at DESC);
CREATE INDEX courses_published ON courses (published_at DESC) WHERE published_revision_id IS NOT NULL;

-- Immutable, like article revisions: every change to a course (its title, modules, lesson order, a lesson's pin)
-- is a new revision, and a published course is always exactly one of these.
CREATE TABLE course_revisions (
  id         text PRIMARY KEY,
  course_id  text NOT NULL REFERENCES courses (id),
  number     integer NOT NULL CHECK (number >= 1),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary    text NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
  author     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, number),
  UNIQUE (course_id, id)
);

CREATE TABLE course_modules (
  revision_id text NOT NULL REFERENCES course_revisions (id),
  position    integer NOT NULL CHECK (position >= 0),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  PRIMARY KEY (revision_id, position)
);

-- A lesson names one article revision (the pin), so a published course never changes when the article gets a new
-- draft or is published again. lesson_id stays the same across a course's revisions: lesson URLs keep working.
CREATE TABLE course_lessons (
  revision_id      text NOT NULL,
  lesson_id        text NOT NULL,
  module_position  integer NOT NULL,
  position         integer NOT NULL CHECK (position >= 0),
  item_id          text NOT NULL,
  item_revision_id text NOT NULL,
  PRIMARY KEY (revision_id, lesson_id),
  UNIQUE (revision_id, module_position, position),
  FOREIGN KEY (revision_id, module_position) REFERENCES course_modules (revision_id, position),
  FOREIGN KEY (item_id, item_revision_id) REFERENCES content_revisions (item_id, id)
);
CREATE INDEX course_lessons_item ON course_lessons (item_id);

CREATE FUNCTION knowledge_course_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'course revisions are immutable: save a new revision';
END $$;
CREATE TRIGGER course_revisions_immutable BEFORE UPDATE OR DELETE ON course_revisions
  FOR EACH ROW EXECUTE FUNCTION knowledge_course_revisions_immutable();
CREATE TRIGGER course_modules_immutable BEFORE UPDATE OR DELETE ON course_modules
  FOR EACH ROW EXECUTE FUNCTION knowledge_course_revisions_immutable();
CREATE TRIGGER course_lessons_immutable BEFORE UPDATE OR DELETE ON course_lessons
  FOR EACH ROW EXECUTE FUNCTION knowledge_course_revisions_immutable();

ALTER TABLE courses
  ADD CONSTRAINT courses_draft_fk FOREIGN KEY (id, draft_revision_id)
    REFERENCES course_revisions (course_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT courses_published_fk FOREIGN KEY (id, published_revision_id)
    REFERENCES course_revisions (course_id, id),
  ADD CONSTRAINT courses_publication CHECK (
    (published_revision_id IS NULL OR (published_at IS NOT NULL AND withdrawn_at IS NULL))
  );

-- Who did what to which course: identifiers only.
CREATE TABLE course_audit_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL CHECK (action IN ('course.created', 'course.saved', 'course.published', 'course.withdrawn')),
  course_id   text NOT NULL REFERENCES courses (id),
  revision_id text
);
CREATE INDEX course_audit_events_course ON course_audit_events (course_id, at);`,
  },
  {
    version: 8,
    name: "media: uploaded assets with quarantine, and the assets each revision uses (#359)",
    sql: `
-- One uploaded file. Its bytes are in the media store: under uploads/<id> while pending (quarantine: never served),
-- under assets/<id> once the server checked its size and first bytes against the type it claimed. Who may read it is
-- worked out per request (lib/media/assets.ts), never stored: public exactly while a public revision uses it.
CREATE TABLE media_assets (
  id            text PRIMARY KEY,
  owner_subject text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'file')),
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf')),
  byte_size     bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400),
  filename      text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  checked_at    timestamptz,
  CHECK ((status = 'pending') = (checked_at IS NULL))
);
CREATE INDEX media_assets_owner ON media_assets (owner_subject, created_at DESC);
CREATE INDEX media_assets_pending ON media_assets (created_at) WHERE status <> 'ready';

-- The assets a revision uses, written with the revision and as immutable. An asset in use can't be deleted.
CREATE TABLE content_revision_media (
  revision_id text NOT NULL REFERENCES content_revisions (id),
  asset_id    text NOT NULL REFERENCES media_assets (id),
  PRIMARY KEY (revision_id, asset_id)
);
CREATE INDEX content_revision_media_asset ON content_revision_media (asset_id);
CREATE TRIGGER content_revision_media_immutable BEFORE UPDATE OR DELETE ON content_revision_media
  FOR EACH ROW EXECUTE FUNCTION knowledge_revisions_immutable();

CREATE TABLE media_audit_events (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,
  action   text NOT NULL CHECK (action IN ('media.requested', 'media.accepted', 'media.rejected', 'media.deleted')),
  asset_id text NOT NULL
);
CREATE INDEX media_audit_events_asset ON media_audit_events (asset_id, at);`,
  },
];

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
      await m.after?.(client);
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
