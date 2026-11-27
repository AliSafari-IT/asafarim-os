/**
 * Articles and their revisions, in the app's own database. Every function that changes something takes
 * the Actor the studio gate established and re-checks the policy against the row it locked, inside the
 * transaction that writes. The public functions take no actor at all: they can only ever read the
 * revision an item's published pointer names, so a draft has no path to a guest.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { decodeCursor, encodeCursor } from "./cursor";
import { checkRevisionMedia, recordRevisionMedia } from "./media/assets";
import { readingMinutes } from "./reading-time";
import { refreshSearchDocument } from "./search-index";
import { canCreate, canEdit, canPublish, canView, seesAll, type Actor } from "./policy";
import type { Doc } from "./doc";
import { SCHEMA_VERSION } from "./doc";
import type { DraftInput } from "./validation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string) => UUID.test(s);

type Pool = Pick<pg.Pool, "connect" | "query">;
type Client = Pick<pg.PoolClient, "query">;

export type RevisionFormat = "markdown" | "tiptap";

export interface Revision {
  id: string;
  number: number;
  /** "tiptap": `doc` is the document and `body` its plain text; "markdown" (Phase 0): `body` is the Markdown. */
  format: RevisionFormat;
  doc: Doc | null;
  title: string;
  summary: string;
  body: string;
  author: string;
  createdAt: Date;
}

export type ItemStatus = "draft" | "published" | "withdrawn";

export interface StudioItem {
  id: string;
  slug: string;
  ownerSubject: string;
  status: ItemStatus;
  draftRevisionId: string;
  publishedRevisionId: string | null;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
  updatedAt: Date;
  /** The draft head: what the editor opens. */
  draft: Revision;
}

export interface PublishedArticle {
  id: string;
  slug: string;
  language: string;
  format: RevisionFormat;
  doc: Doc | null;
  title: string;
  summary: string;
  body: string;
  publishedAt: Date;
  revisionNumber: number;
  /** The article owner's display name (lib/authors.ts), or null until they have signed in to the studio since it existed. */
  authorName: string | null;
  /** Minutes to read, from the text. At least 1. */
  readingMinutes: number;
  topic: { slug: string; name: string } | null;
  level: string | null;
}

/** One page of a list, newest first, and the cursor of the next (older) page, or null on the last one. */
export interface Page<T> {
  items: T[];
  next: string | null;
}

export const PAGE_SIZE = { studio: 50, public: 20, revisions: 30 } as const;

export type Failure =
  | { ok: false; error: "forbidden" }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "slug_taken" }
  | { ok: false; error: "conflict"; currentRevisionId: string }
  | { ok: false; error: "unknown_revision" }
  | { ok: false; error: "not_published" }
  | { ok: false; error: "not_deletable" }
  | { ok: false; error: "in_course" }
  | { ok: false; error: "invalid_slug" }
  | { ok: false; error: "media_unavailable" };

export type Result<T> = ({ ok: true } & T) | Failure;

interface ItemRow {
  id: string;
  slug: string;
  owner_subject: string;
  draft_revision_id: string;
  published_revision_id: string | null;
  published_at: Date | null;
  withdrawn_at: Date | null;
  updated_at: Date;
}

interface RevisionRow {
  id: string;
  number: number;
  format: RevisionFormat;
  doc: Doc | null;
  title: string;
  summary: string;
  body: string;
  author: string;
  created_at: Date;
}

const toRevision = (r: RevisionRow): Revision => ({
  id: r.id,
  number: r.number,
  format: r.format,
  doc: r.doc,
  title: r.title,
  summary: r.summary,
  body: r.body,
  author: r.author,
  createdAt: r.created_at,
});

const statusOf = (r: Pick<ItemRow, "published_revision_id" | "withdrawn_at">): ItemStatus =>
  r.published_revision_id ? "published" : r.withdrawn_at ? "withdrawn" : "draft";

const ownerOf = (r: ItemRow) => ({ ownerSubject: r.owner_subject });

async function inTransaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function audit(c: Client, actor: Actor, action: string, itemId: string, revisionId: string | null) {
  await c.query("INSERT INTO audit_events (actor, action, item_id, revision_id) VALUES ($1, $2, $3, $4)", [
    `user:${actor.subject}`,
    action,
    itemId,
    revisionId,
  ]);
}

async function insertRevision(c: Client, itemId: string, number: number, draft: DraftInput, author: string) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO content_revisions (id, item_id, number, format, doc, schema_version, title, summary, body, author)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      itemId,
      number,
      draft.doc ? "tiptap" : "markdown",
      draft.doc ? JSON.stringify(draft.doc) : null,
      draft.doc ? SCHEMA_VERSION : null,
      draft.title,
      draft.summary,
      draft.body,
      author,
    ],
  );
  return id;
}

const slugIsRedirect = async (c: Client, slug: string) =>
  ((await c.query("SELECT 1 FROM slug_redirects WHERE old_slug = $1", [slug])).rowCount ?? 0) > 0;

const lockItem = async (c: Client, id: string) =>
  (await c.query<ItemRow>("SELECT * FROM content_items WHERE id = $1 FOR UPDATE", [id])).rows[0];

/** A new article: the item and its first revision, which is its draft head. Nothing is public yet. */
export async function createArticle(
  pool: Pool,
  actor: Actor,
  input: { slug: string; draft: DraftInput },
): Promise<Result<{ id: string; revisionId: string }>> {
  if (!canCreate(actor)) return { ok: false, error: "forbidden" };
  return inTransaction(pool, async (c) => {
    const id = randomUUID();
    // An old address keeps leading to its article: a new article can't take it (#372). Under the same lock as
    // changeSlug, so a slug that is becoming a redirect can't be claimed in between.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('knowledge.slug_redirects'))");
    if (await slugIsRedirect(c, input.slug)) return { ok: false, error: "slug_taken" } as const;
    // Before anything is written: a refusal returns, and this transaction commits only what came before.
    const media = await checkRevisionMedia(c, actor, { id: null, ownerSubject: actor.subject }, input.draft.doc);
    if (!media.ok) return media;
    const inserted = await c.query(
      `INSERT INTO content_items (id, owner_subject, slug) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
      [id, actor.subject, input.slug],
    );
    if (inserted.rowCount === 0) return { ok: false, error: "slug_taken" } as const;
    const revisionId = await insertRevision(c, id, 1, input.draft, actor.subject);
    await recordRevisionMedia(c, revisionId, media.ids);
    await c.query("UPDATE content_items SET draft_revision_id = $2 WHERE id = $1", [id, revisionId]);
    await audit(c, actor, "content.created", id, revisionId);
    return { ok: true, id, revisionId } as const;
  });
}

/**
 * Save the editor's content as a new revision, but only on top of the revision the editor opened: if
 * someone saved in between, nothing is written and the caller gets the newer revision's id (409).
 * The published revision is untouched: a saved draft is never public until it is published.
 */
export async function saveDraft(
  pool: Pool,
  actor: Actor,
  input: { id: string; expectedRevisionId: string; draft: DraftInput },
): Promise<Result<{ revisionId: string }>> {
  return inTransaction(pool, async (c) => {
    const item = await lockItem(c, input.id);
    if (!item || !canView(actor, ownerOf(item))) return { ok: false, error: "not_found" } as const;
    if (!canEdit(actor, ownerOf(item))) return { ok: false, error: "forbidden" } as const;
    if (item.draft_revision_id !== input.expectedRevisionId) {
      return { ok: false, error: "conflict", currentRevisionId: item.draft_revision_id } as const;
    }
    // Media (#359): every asset the document uses must be one this author may use, checked under the item's lock.
    const media = await checkRevisionMedia(
      c,
      actor,
      { id: item.id, ownerSubject: item.owner_subject },
      input.draft.doc,
    );
    if (!media.ok) return media;
    const { rows } = await c.query<{ n: number }>(
      "SELECT max(number)::int AS n FROM content_revisions WHERE item_id = $1",
      [item.id],
    );
    const revisionId = await insertRevision(c, item.id, (rows[0]?.n ?? 0) + 1, input.draft, actor.subject);
    await recordRevisionMedia(c, revisionId, media.ids);
    await c.query("UPDATE content_items SET draft_revision_id = $2, updated_at = now() WHERE id = $1", [
      item.id,
      revisionId,
    ]);
    // The author's unsaved text is now a revision: the autosave has done its job.
    await c.query("DELETE FROM draft_autosaves WHERE item_id = $1 AND author = $2", [item.id, actor.subject]);
    await audit(c, actor, "content.saved", item.id, revisionId);
    return { ok: true, revisionId } as const;
  });
}

/** Make exactly `revisionId` (one of this item's own revisions) the public version, in one statement. */
export async function publishRevision(
  pool: Pool,
  actor: Actor,
  input: { id: string; revisionId: string },
): Promise<Result<{ revisionId: string }>> {
  return inTransaction(pool, async (c) => {
    const item = await lockItem(c, input.id);
    if (!item || !canView(actor, ownerOf(item))) return { ok: false, error: "not_found" } as const;
    if (!canPublish(actor, ownerOf(item))) return { ok: false, error: "forbidden" } as const;
    const own = await c.query("SELECT 1 FROM content_revisions WHERE item_id = $1 AND id = $2", [
      item.id,
      input.revisionId,
    ]);
    if (own.rowCount === 0) return { ok: false, error: "unknown_revision" } as const;
    await c.query(
      `UPDATE content_items SET published_revision_id = $2, published_at = now(), withdrawn_at = NULL, updated_at = now()
       WHERE id = $1`,
      [item.id, input.revisionId],
    );
    // The public search projection changes in the same transaction (#357).
    await refreshSearchDocument(c, item.id);
    await audit(c, actor, "content.published", item.id, input.revisionId);
    return { ok: true, revisionId: input.revisionId } as const;
  });
}

/** Take the article off the public site at once. Its revisions stay, and it can be published again. */
export async function withdrawArticle(pool: Pool, actor: Actor, input: { id: string }): Promise<Result<object>> {
  return inTransaction(pool, async (c) => {
    const item = await lockItem(c, input.id);
    if (!item || !canView(actor, ownerOf(item))) return { ok: false, error: "not_found" } as const;
    if (!canPublish(actor, ownerOf(item))) return { ok: false, error: "forbidden" } as const;
    if (!item.published_revision_id) return { ok: false, error: "not_published" } as const;
    await c.query(
      `UPDATE content_items SET published_revision_id = NULL, published_at = NULL, withdrawn_at = now(), updated_at = now()
       WHERE id = $1`,
      [item.id],
    );
    // The public search projection changes in the same transaction (#357).
    await refreshSearchDocument(c, item.id);
    await audit(c, actor, "content.withdrawn", item.id, item.published_revision_id);
    return { ok: true } as const;
  });
}

/**
 * Permanently delete an article that was never published (status "draft": no public revision and never withdrawn,
 * since a withdrawn article was public once). Whoever may edit it may delete it. A published or withdrawn article
 * is refused: it has been public, so it is withdrawn, not deleted.
 *
 * Gone with it: every revision and the media links written with them, the autosave, its tag links and any old
 * addresses, so its slug is free again. Kept: the audit log and the AI job log (they hold identifiers and token
 * counts, never text, and since migration 9 they don't point at the article), and the uploaded files, which stay in
 * the media library. One transaction, so a failure leaves the article exactly as it was.
 *
 * The revision tables are immutable; migration 9 lets a DELETE through only while this transaction has named this
 * article (the set_config below) and the database itself finds it never published.
 */
export async function deleteDraftArticle(pool: Pool, actor: Actor, input: { id: string }): Promise<Result<object>> {
  return inTransaction(pool, async (c) => {
    const item = await lockItem(c, input.id);
    if (!item || !canView(actor, ownerOf(item))) return { ok: false, error: "not_found" } as const;
    if (!canEdit(actor, ownerOf(item))) return { ok: false, error: "forbidden" } as const;
    if (statusOf(item) !== "draft") return { ok: false, error: "not_deletable" } as const;
    // A course lesson pins a published revision, so a never-published article can't be one; check anyway, since the
    // lesson rows are immutable and would otherwise surface as a foreign-key error half way through.
    const lesson = await c.query("SELECT 1 FROM course_lessons WHERE item_id = $1 LIMIT 1", [item.id]);
    if (lesson.rowCount) return { ok: false, error: "in_course" } as const;

    await c.query("SELECT set_config('knowledge.deleting_draft', $1, true)", [item.id]);
    // Everything that points at the article or its revisions, then the revisions, then the article.
    await c.query("DELETE FROM search_documents WHERE item_id = $1", [item.id]);
    await c.query("DELETE FROM draft_autosaves WHERE item_id = $1", [item.id]);
    await c.query("DELETE FROM item_tags WHERE item_id = $1", [item.id]);
    await c.query("DELETE FROM slug_redirects WHERE item_id = $1", [item.id]);
    await c.query(
      "DELETE FROM content_revision_media WHERE revision_id IN (SELECT id FROM content_revisions WHERE item_id = $1)",
      [item.id],
    );
    await c.query("DELETE FROM content_revisions WHERE item_id = $1", [item.id]);
    await c.query("DELETE FROM content_items WHERE id = $1", [item.id]);
    await audit(c, actor, "content.deleted", item.id, null);
    return { ok: true } as const;
  });
}

const STUDIO_SELECT = `
  SELECT i.*, r.id AS r_id, r.number, r.format, r.doc, r.title, r.summary, r.body, r.author, r.created_at AS r_created_at
  FROM content_items i JOIN content_revisions r ON r.id = i.draft_revision_id`;

type StudioRow = ItemRow & Omit<RevisionRow, "id" | "created_at"> & { r_id: string; r_created_at: Date };

const toStudioItem = (r: StudioRow): StudioItem => ({
  id: r.id,
  slug: r.slug,
  ownerSubject: r.owner_subject,
  status: statusOf(r),
  draftRevisionId: r.draft_revision_id,
  publishedRevisionId: r.published_revision_id,
  publishedAt: r.published_at,
  withdrawnAt: r.withdrawn_at,
  updatedAt: r.updated_at,
  draft: toRevision({ ...r, id: r.r_id, created_at: r.r_created_at }),
});

/**
 * The studio's list, one page at a time: the person's own articles, or every article for an editor, most recently
 * changed first. Keyset pagination on (updated_at, id), so a page never repeats or skips a row while others write.
 */
export async function listStudioItems(
  pool: Pool,
  actor: Actor,
  opts: { after?: string | null; limit?: number } = {},
): Promise<Page<StudioItem>> {
  const limit = opts.limit ?? PAGE_SIZE.studio;
  const after = decodeCursor(opts.after);
  const { rows } = await pool.query<StudioRow & { at_key: string }>(
    `SELECT * FROM (
       SELECT i.*, i.updated_at::text AS at_key, r.id AS r_id, r.number, r.format, r.doc, r.title, r.summary, r.body, r.author,
              r.created_at AS r_created_at
       FROM content_items i JOIN content_revisions r ON r.id = i.draft_revision_id
       WHERE ($1::boolean OR i.owner_subject = $2)
         AND ($3::timestamptz IS NULL OR (i.updated_at, i.id) < ($3::timestamptz, $4::text))
     ) x ORDER BY x.updated_at DESC, x.id DESC LIMIT $5`,
    [seesAll(actor), actor.subject, after?.at ?? null, after?.id ?? null, limit + 1],
  );
  return pageOf(
    rows,
    limit,
    (r) => r.at_key,
    (r) => toStudioItem(r),
    (r) => canView(actor, ownerOf(r)),
  );
}

export function pageOf<R extends { id: string }, T>(
  rows: R[],
  limit: number,
  key: (r: R) => string,
  map: (r: R) => T,
  keep: (r: R) => boolean = () => true,
): Page<T> {
  const more = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    items: shown.filter(keep).map(map),
    next: more && last ? encodeCursor({ at: key(last), id: last.id }) : null,
  };
}

export interface StudioItemView {
  item: StudioItem;
  /** One page of the revision history, newest first. */
  revisions: Revision[];
  /** Show older revisions with `before=<this>`; null when this page reaches revision 1. */
  olderBefore: number | null;
  /** The public revision, wherever it is in the history (it may be on another page). */
  published: Revision | null;
}

/**
 * One article for the editor: the draft head, a page of its revision history (newest first, `before` a revision
 * number for older pages) and the published revision. Null when the person may not see it.
 */
export async function getStudioItem(
  pool: Pool,
  actor: Actor,
  id: string,
  opts: { before?: number | null; limit?: number } = {},
): Promise<StudioItemView | null> {
  if (!UUID.test(id)) return null;
  const row = (await pool.query<StudioRow>(`${STUDIO_SELECT} WHERE i.id = $1`, [id])).rows[0];
  if (!row || !canView(actor, ownerOf(row))) return null;
  const limit = opts.limit ?? PAGE_SIZE.revisions;
  const { rows } = await pool.query<RevisionRow>(
    `SELECT * FROM content_revisions WHERE item_id = $1 AND ($2::int IS NULL OR number < $2::int)
     ORDER BY number DESC LIMIT $3`,
    [id, opts.before ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const published = row.published_revision_id
    ? (page.find((r) => r.id === row.published_revision_id) ??
      (
        await pool.query<RevisionRow>("SELECT * FROM content_revisions WHERE id = $1 AND item_id = $2", [
          row.published_revision_id,
          id,
        ])
      ).rows[0])
    : undefined;
  return {
    item: toStudioItem(row),
    revisions: page.map(toRevision),
    olderBefore: rows.length > limit ? (page.at(-1)?.number ?? null) : null,
    published: published ? toRevision(published) : null,
  };
}

// The public side. Each query joins on published_revision_id, the one pointer publish/withdraw change.
const PUBLIC_SELECT = `
  SELECT i.id, i.slug, i.language, i.published_at, i.published_at::text AS at_key, r.format, r.doc, r.title, r.summary,
         r.body, r.number, i.level, a.display_name AS author_name, t.slug AS topic_slug, t.name AS topic_name
  FROM content_items i JOIN content_revisions r ON r.id = i.published_revision_id AND r.item_id = i.id
       LEFT JOIN authors a ON a.subject = i.owner_subject
       LEFT JOIN topics t ON t.id = i.topic_id
  WHERE i.published_revision_id IS NOT NULL`;

interface PublicRow {
  id: string;
  at_key: string;
  slug: string;
  language: string;
  format: RevisionFormat;
  doc: Doc | null;
  published_at: Date;
  title: string;
  summary: string;
  body: string;
  number: number;
  level: string | null;
  author_name: string | null;
  topic_slug: string | null;
  topic_name: string | null;
}

const toPublished = (r: PublicRow): PublishedArticle => ({
  id: r.id,
  slug: r.slug,
  language: r.language,
  format: r.format,
  doc: r.doc,
  title: r.title,
  summary: r.summary,
  body: r.body,
  publishedAt: r.published_at,
  revisionNumber: r.number,
  authorName: r.author_name,
  readingMinutes: readingMinutes(r.body),
  topic: r.topic_slug && r.topic_name ? { slug: r.topic_slug, name: r.topic_name } : null,
  level: r.level,
});

/** Published articles, newest first, one page at a time (keyset on published_at, id): what a guest may list. */
export async function listPublished(
  pool: Pick<Pool, "query">,
  opts: { after?: string | null; limit?: number } = {},
): Promise<Page<PublishedArticle>> {
  const limit = opts.limit ?? PAGE_SIZE.public;
  const after = decodeCursor(opts.after);
  const { rows } = await pool.query<PublicRow>(
    `${PUBLIC_SELECT} AND ($1::timestamptz IS NULL OR (i.published_at, i.id) < ($1::timestamptz, $2::text))
     ORDER BY i.published_at DESC, i.id DESC LIMIT $3`,
    [after?.at ?? null, after?.id ?? null, limit + 1],
  );
  return pageOf(rows, limit, (r) => r.at_key, toPublished);
}

/** The published revision of the article at `slug`, or null (never published, withdrawn, or no such slug). */
export async function getPublishedArticle(pool: Pick<Pool, "query">, slug: string): Promise<PublishedArticle | null> {
  const row = (await pool.query<PublicRow>(`${PUBLIC_SELECT} AND i.slug = $1`, [slug])).rows[0];
  return row ? toPublished(row) : null;
}

/**
 * Where an old address of a published article leads now (#372): its current slug, or null when the slug was never
 * an old address or the article isn't public (a guest then gets the same 404 as for any unknown slug).
 */
export async function resolveSlugRedirect(pool: Pick<Pool, "query">, slug: string): Promise<string | null> {
  const { rows } = await pool.query<{ slug: string }>(
    `SELECT i.slug FROM slug_redirects s JOIN content_items i ON i.id = s.item_id
     WHERE s.old_slug = $1 AND i.published_revision_id IS NOT NULL`,
    [slug],
  );
  return rows[0]?.slug ?? null;
}

/**
 * Give an article a new address (#372). Once an article has been public (published now, or withdrawn), changing
 * its address is a publishing decision (canPublish), and the old address is kept as a redirect to the article; a
 * never-published draft just moves (canEdit). Taking back one of the article's own old slugs removes that redirect,
 * so a slug is never both an address and a redirect, and redirects never chain.
 */
export async function changeSlug(
  pool: Pool,
  actor: Actor,
  input: { id: string; slug: string },
): Promise<Result<{ slug: string; previous: string }>> {
  return inTransaction(pool, async (c) => {
    const item = await lockItem(c, input.id);
    if (!item || !canView(actor, ownerOf(item))) return { ok: false, error: "not_found" } as const;
    const wasPublic = item.published_revision_id !== null || item.withdrawn_at !== null;
    const allowed = wasPublic ? canPublish(actor, ownerOf(item)) : canEdit(actor, ownerOf(item));
    if (!allowed) return { ok: false, error: "forbidden" } as const;
    if (input.slug === item.slug) return { ok: true, slug: item.slug, previous: item.slug } as const;
    // Serialise slug changes, so two articles can't trade addresses into a state the checks below would refuse.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('knowledge.slug_redirects'))");
    const redirect = (
      await c.query<{ item_id: string }>("SELECT item_id FROM slug_redirects WHERE old_slug = $1", [input.slug])
    ).rows[0];
    if (redirect && redirect.item_id !== item.id) return { ok: false, error: "slug_taken" } as const;
    const taken = await c.query("SELECT 1 FROM content_items WHERE slug = $1", [input.slug]);
    if ((taken.rowCount ?? 0) > 0) return { ok: false, error: "slug_taken" } as const;
    if (redirect) await c.query("DELETE FROM slug_redirects WHERE old_slug = $1", [input.slug]);
    if (wasPublic) {
      await c.query("INSERT INTO slug_redirects (old_slug, item_id) VALUES ($1, $2)", [item.slug, item.id]);
    }
    await c.query("UPDATE content_items SET slug = $2, updated_at = now() WHERE id = $1", [item.id, input.slug]);
    // The public search projection changes in the same transaction (#357).
    await refreshSearchDocument(c, item.id);
    await audit(c, actor, "content.slug_changed", item.id, null);
    return { ok: true, slug: input.slug, previous: item.slug } as const;
  });
}

/** The editor's unsaved text for one author (#372). */
export interface Autosave {
  baseRevisionId: string;
  /** The base revision's number, to name it in the studio. */
  baseNumber: number;
  title: string;
  summary: string;
  doc: Doc;
  body: string;
  savedAt: Date;
}

/**
 * Keep the editor's current text (#372), overwriting this author's previous autosave of the article. It is always
 * stored, so nothing typed is lost, and it never becomes a revision. When the draft head has moved past the
 * revision the editor opened, the result says so (`conflict`) and names the newer revision: the editor then offers
 * a comparison instead of a save that would put this text on top unseen.
 */
export async function autosaveDraft(
  pool: Pool,
  actor: Actor,
  input: { id: string; baseRevisionId: string; draft: DraftInput & { doc: Doc } },
): Promise<Result<{ savedAt: Date; conflict: string | null }>> {
  return inTransaction(pool, async (c) => {
    const item = await lockItem(c, input.id);
    if (!item || !canView(actor, ownerOf(item))) return { ok: false, error: "not_found" } as const;
    if (!canEdit(actor, ownerOf(item))) return { ok: false, error: "forbidden" } as const;
    const own = await c.query("SELECT 1 FROM content_revisions WHERE item_id = $1 AND id = $2", [
      item.id,
      input.baseRevisionId,
    ]);
    if (own.rowCount === 0) return { ok: false, error: "unknown_revision" } as const;
    const { rows } = await c.query<{ saved_at: Date }>(
      `INSERT INTO draft_autosaves (item_id, author, base_revision_id, title, summary, doc, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (item_id, author) DO UPDATE SET base_revision_id = EXCLUDED.base_revision_id, title = EXCLUDED.title,
         summary = EXCLUDED.summary, doc = EXCLUDED.doc, body = EXCLUDED.body, saved_at = now()
       RETURNING saved_at`,
      [
        item.id,
        actor.subject,
        input.baseRevisionId,
        input.draft.title,
        input.draft.summary,
        JSON.stringify(input.draft.doc),
        input.draft.body,
      ],
    );
    const conflict = item.draft_revision_id !== input.baseRevisionId ? item.draft_revision_id : null;
    return { ok: true, savedAt: rows[0]!.saved_at, conflict } as const;
  });
}

/** This author's autosave of an article they may still edit, or null. */
export async function getAutosave(pool: Pick<Pool, "query">, actor: Actor, id: string): Promise<Autosave | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query<{
    owner_subject: string;
    base_revision_id: string;
    number: number;
    title: string;
    summary: string;
    doc: Doc;
    body: string;
    saved_at: Date;
  }>(
    `SELECT i.owner_subject, a.base_revision_id, r.number, a.title, a.summary, a.doc, a.body, a.saved_at
     FROM draft_autosaves a JOIN content_items i ON i.id = a.item_id
     JOIN content_revisions r ON r.id = a.base_revision_id AND r.item_id = a.item_id
     WHERE a.item_id = $1 AND a.author = $2`,
    [id, actor.subject],
  );
  const r = rows[0];
  if (!r || !canEdit(actor, { ownerSubject: r.owner_subject })) return null;
  return {
    baseRevisionId: r.base_revision_id,
    baseNumber: r.number,
    title: r.title,
    summary: r.summary,
    doc: r.doc,
    body: r.body,
    savedAt: r.saved_at,
  };
}

/** Throw away this author's autosave of an article (the "Discard" in the studio). */
export async function discardAutosave(pool: Pick<Pool, "query">, actor: Actor, id: string): Promise<void> {
  if (!UUID.test(id)) return;
  await pool.query("DELETE FROM draft_autosaves WHERE item_id = $1 AND author = $2", [id, actor.subject]);
}

/** One revision of an article the person may see, by its number, or null. For preview and comparison. */
export async function getRevision(
  pool: Pick<Pool, "query">,
  actor: Actor,
  id: string,
  number: number,
): Promise<{
  item: Pick<StudioItem, "id" | "slug" | "draftRevisionId" | "publishedRevisionId">;
  revision: Revision;
} | null> {
  if (!UUID.test(id) || !Number.isSafeInteger(number) || number < 1) return null;
  const { rows } = await pool.query<RevisionRow & ItemRow & { r_id: string; r_created_at: Date }>(
    `SELECT i.*, r.id AS r_id, r.number, r.format, r.doc, r.title, r.summary, r.body, r.author, r.created_at AS r_created_at
     FROM content_items i JOIN content_revisions r ON r.item_id = i.id
     WHERE i.id = $1 AND r.number = $2`,
    [id, number],
  );
  const r = rows[0];
  if (!r || !canView(actor, ownerOf(r))) return null;
  return {
    item: {
      id: r.id,
      slug: r.slug,
      draftRevisionId: r.draft_revision_id,
      publishedRevisionId: r.published_revision_id,
    },
    revision: toRevision({ ...r, id: r.r_id, created_at: r.r_created_at }),
  };
}
