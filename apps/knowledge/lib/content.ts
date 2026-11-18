/**
 * Articles and their revisions, in the app's own database. Every function that changes something takes
 * the Actor the studio gate established and re-checks the policy against the row it locked, inside the
 * transaction that writes. The public functions take no actor at all: they can only ever read the
 * revision an item's published pointer names, so a draft has no path to a guest.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { canCreate, canEdit, canPublish, canView, seesAll, type Actor } from "./policy";
import type { DraftInput } from "./validation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string) => UUID.test(s);

type Pool = Pick<pg.Pool, "connect" | "query">;
type Client = Pick<pg.PoolClient, "query">;

export interface Revision {
  id: string;
  number: number;
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
  slug: string;
  language: string;
  title: string;
  summary: string;
  body: string;
  publishedAt: Date;
  revisionNumber: number;
}

export type Failure =
  | { ok: false; error: "forbidden" }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "slug_taken" }
  | { ok: false; error: "conflict"; currentRevisionId: string }
  | { ok: false; error: "unknown_revision" }
  | { ok: false; error: "not_published" };

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
  title: string;
  summary: string;
  body: string;
  author: string;
  created_at: Date;
}

const toRevision = (r: RevisionRow): Revision => ({
  id: r.id,
  number: r.number,
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
    `INSERT INTO content_revisions (id, item_id, number, title, summary, body, author)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, itemId, number, draft.title, draft.summary, draft.body, author],
  );
  return id;
}

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
    const inserted = await c.query(
      `INSERT INTO content_items (id, owner_subject, slug) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
      [id, actor.subject, input.slug],
    );
    if (inserted.rowCount === 0) return { ok: false, error: "slug_taken" } as const;
    const revisionId = await insertRevision(c, id, 1, input.draft, actor.subject);
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
    const { rows } = await c.query<{ n: number }>(
      "SELECT max(number)::int AS n FROM content_revisions WHERE item_id = $1",
      [item.id],
    );
    const revisionId = await insertRevision(c, item.id, (rows[0]?.n ?? 0) + 1, input.draft, actor.subject);
    await c.query("UPDATE content_items SET draft_revision_id = $2, updated_at = now() WHERE id = $1", [
      item.id,
      revisionId,
    ]);
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
    await audit(c, actor, "content.withdrawn", item.id, item.published_revision_id);
    return { ok: true } as const;
  });
}

const STUDIO_SELECT = `
  SELECT i.*, r.id AS r_id, r.number, r.title, r.summary, r.body, r.author, r.created_at AS r_created_at
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

/** The studio's list: the person's own articles, or every article for an editor. */
export async function listStudioItems(pool: Pool, actor: Actor, limit = 100): Promise<StudioItem[]> {
  const all = seesAll(actor);
  const { rows } = await pool.query<StudioRow>(
    `${STUDIO_SELECT} WHERE ($1::boolean OR i.owner_subject = $2) ORDER BY i.updated_at DESC LIMIT $3`,
    [all, actor.subject, limit],
  );
  return rows.filter((r) => canView(actor, ownerOf(r))).map(toStudioItem);
}

/** One article for the editor, with its revision history (newest first); null when the person may not see it. */
export async function getStudioItem(
  pool: Pool,
  actor: Actor,
  id: string,
): Promise<{ item: StudioItem; revisions: Revision[] } | null> {
  if (!UUID.test(id)) return null;
  const row = (await pool.query<StudioRow>(`${STUDIO_SELECT} WHERE i.id = $1`, [id])).rows[0];
  if (!row || !canView(actor, ownerOf(row))) return null;
  const { rows } = await pool.query<RevisionRow>(
    "SELECT * FROM content_revisions WHERE item_id = $1 ORDER BY number DESC LIMIT 50",
    [id],
  );
  return { item: toStudioItem(row), revisions: rows.map(toRevision) };
}

// The public side. Each query joins on published_revision_id, the one pointer publish/withdraw change.
const PUBLIC_SELECT = `
  SELECT i.slug, i.language, i.published_at, r.title, r.summary, r.body, r.number
  FROM content_items i JOIN content_revisions r ON r.id = i.published_revision_id AND r.item_id = i.id
  WHERE i.published_revision_id IS NOT NULL`;

interface PublicRow {
  slug: string;
  language: string;
  published_at: Date;
  title: string;
  summary: string;
  body: string;
  number: number;
}

const toPublished = (r: PublicRow): PublishedArticle => ({
  slug: r.slug,
  language: r.language,
  title: r.title,
  summary: r.summary,
  body: r.body,
  publishedAt: r.published_at,
  revisionNumber: r.number,
});

/** Published articles, newest first: what a guest may list. */
export async function listPublished(pool: Pick<Pool, "query">, limit = 50): Promise<PublishedArticle[]> {
  const { rows } = await pool.query<PublicRow>(`${PUBLIC_SELECT} ORDER BY i.published_at DESC LIMIT $1`, [limit]);
  return rows.map(toPublished);
}

/** The published revision of the article at `slug`, or null (never published, withdrawn, or no such slug). */
export async function getPublishedArticle(pool: Pick<Pool, "query">, slug: string): Promise<PublishedArticle | null> {
  const row = (await pool.query<PublicRow>(`${PUBLIC_SELECT} AND i.slug = $1`, [slug])).rows[0];
  return row ? toPublished(row) : null;
}
