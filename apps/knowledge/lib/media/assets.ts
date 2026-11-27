/**
 * Uploaded media (#359): the asset records, the upload handshake, who may read an asset, and cleanup.
 *
 * The upload is direct and in two steps. `requestUpload` checks the type and size the author claims, records a
 * pending asset and hands out a presigned PUT for `uploads/<id>` (quarantine). The browser sends the file to the
 * store itself. `finishUpload` then checks what actually arrived (its size, and that its first bytes are the type it
 * claimed), and only then marks it ready. It checks the copy in `assets/<id>`, which only the server writes, so bytes
 * swapped into `uploads/<id>` after a check can't slip through. Nothing under `uploads/` is ever served.
 *
 * Deleting is in two steps too: the record is first marked `deleting` (no read, revision or library sees it), then its
 * bytes go, then the record. A failure in between leaves a `deleting` record that cleanup retries.
 *
 * Reading: an asset is public exactly while a public revision uses it (an article's published revision, or a lesson
 * of a published course whose article is public). Otherwise only its uploader, people who see every article, and
 * people who may see an article that uses it can read it. Nothing is "promoted" by copying: withdrawing an article
 * makes its media private again at once.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pageOf, PAGE_SIZE, type Page } from "../content";
import { decodeCursor } from "../cursor";
import { mediaAssetIds, type Doc } from "../doc";
import { canCreate, canView, seesAll, type Actor } from "../policy";
import type { MediaStore } from "./store";
import { checkUploadRequest, isAssetId, SNIFF_BYTES, sniffMatches, type MediaKind, type MediaType } from "./validate";

type Pool = Pick<pg.Pool, "connect" | "query">;
type Client = Pick<pg.PoolClient, "query">;

export type MediaResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export type AssetStatus = "pending" | "ready" | "rejected" | "deleting";

export interface MediaAsset {
  id: string;
  ownerSubject: string;
  kind: MediaKind;
  contentType: MediaType;
  byteSize: number;
  filename: string;
  status: AssetStatus;
  createdAt: Date;
}

interface AssetRow {
  id: string;
  owner_subject: string;
  kind: MediaKind;
  content_type: MediaType;
  byte_size: string;
  filename: string;
  status: AssetStatus;
  created_at: Date;
}

const toAsset = (r: AssetRow): MediaAsset => ({
  id: r.id,
  ownerSubject: r.owner_subject,
  kind: r.kind,
  contentType: r.content_type,
  byteSize: Number(r.byte_size),
  filename: r.filename,
  status: r.status,
  createdAt: r.created_at,
});

export const uploadKey = (id: string) => `uploads/${id}`;
export const assetKey = (id: string) => `assets/${id}`;

/** Pending uploads one person may have open at a time: a flood of unfinished uploads stops here. */
export const MAX_PENDING = 20;
/** How long cleanup leaves things alone: an unfinished upload, and a ready asset no revision uses yet. */
export const CLEANUP_AGE = { pending: 24 * 3600_000, unused: 7 * 24 * 3600_000 } as const;

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

const audit = (c: Client, actor: string, action: string, assetId: string) =>
  c.query("INSERT INTO media_audit_events (actor, action, asset_id) VALUES ($1, $2, $3)", [actor, action, assetId]);

/** Step 1: record a pending asset and hand out the presigned upload for it. */
export async function requestUpload(
  pool: Pool,
  store: MediaStore,
  actor: Actor,
  input: { contentType: unknown; size: unknown; filename: unknown },
): Promise<MediaResult<{ id: string; url: string; headers: Record<string, string> }>> {
  if (!canCreate(actor)) return { ok: false, error: "forbidden" };
  const check = checkUploadRequest(input);
  if (!check.ok) return check;
  return inTransaction(pool, async (c) => {
    // One person's requests one at a time, so the pending count can't be raced past.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('knowledge.media:' || $1))", [actor.subject]);
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM media_assets WHERE owner_subject = $1 AND status = 'pending'",
      [actor.subject],
    );
    if (rows[0]!.n >= MAX_PENDING) return { ok: false, error: "media_too_many_pending" } as const;
    const id = randomUUID();
    await c.query(
      `INSERT INTO media_assets (id, owner_subject, kind, content_type, byte_size, filename) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, actor.subject, check.kind, check.contentType, check.size, check.filename],
    );
    await audit(c, `user:${actor.subject}`, "media.requested", id);
    const { url, headers } = store.presignUpload(uploadKey(id), check.contentType, check.size);
    return { ok: true, id, url, headers } as const;
  });
}

/**
 * Step 2, after the browser's PUT: check what arrived and accept or reject it. Only the uploader finishes an upload.
 * A file that isn't there yet leaves the asset pending (the browser may still be sending it).
 */
export async function finishUpload(
  pool: Pool,
  store: MediaStore,
  actor: Actor,
  id: string,
): Promise<MediaResult<{ asset: MediaAsset }>> {
  if (!isAssetId(id)) return { ok: false, error: "not_found" };
  const result = await inTransaction(pool, async (c): Promise<MediaResult<{ asset: MediaAsset }>> => {
    const row = (await c.query<AssetRow>("SELECT * FROM media_assets WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!row || row.owner_subject !== actor.subject || row.status === "deleting") {
      return { ok: false, error: "not_found" } as const;
    }
    if (row.status === "ready") return { ok: true, asset: toAsset(row) } as const;
    if (row.status === "rejected") return { ok: false, error: "media_rejected" } as const;
    const info = await store.head(uploadKey(id));
    if (!info) return { ok: false, error: "media_not_uploaded" } as const;
    // Check the server's own copy: what is checked is what is served, even if `uploads/<id>` changes meanwhile.
    await store.copy(uploadKey(id), assetKey(id));
    const copied = await store.head(assetKey(id));
    const fits =
      copied !== null &&
      copied.size === Number(row.byte_size) &&
      sniffMatches(row.content_type, await store.readStart(assetKey(id), SNIFF_BYTES));
    if (!fits) {
      await store.remove(assetKey(id));
      await store.remove(uploadKey(id));
      await c.query("UPDATE media_assets SET status = 'rejected', checked_at = now() WHERE id = $1", [id]);
      await audit(c, `user:${actor.subject}`, "media.rejected", id);
      return { ok: false, error: "media_rejected" } as const;
    }
    const ready = (
      await c.query<AssetRow>(
        "UPDATE media_assets SET status = 'ready', checked_at = now() WHERE id = $1 RETURNING *",
        [id],
      )
    ).rows[0]!;
    await audit(c, `user:${actor.subject}`, "media.accepted", id);
    return { ok: true, asset: toAsset(ready) } as const;
  });
  // The quarantine copy goes only once the asset is ready: until then a retry still needs it. Left behind, it is
  // removed with the asset (deleteAsset, cleanup) and never served.
  if (result.ok) await store.remove(uploadKey(id)).catch(() => undefined);
  return result;
}

/**
 * Before a revision is saved: every asset its document uses must be ready, of the right kind for its node, and one
 * this author may use (their own, the article owner's, one the article already used, or any for someone who sees
 * every article). Run inside the saving transaction; it holds the assets (FOR SHARE) so a delete waits for the save
 * and then sees the new use.
 */
export async function checkRevisionMedia(
  c: Client,
  actor: Actor,
  item: { id: string | null; ownerSubject: string },
  doc: Doc | undefined,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: "media_unavailable" }> {
  if (!doc) return { ok: true, ids: [] };
  const ids = mediaAssetIds(doc);
  if (!ids.length) return { ok: true, ids };
  const { rows } = await c.query<{ id: string; kind: MediaKind }>(
    `SELECT a.id, a.kind FROM media_assets a
     WHERE a.id = ANY($1::text[]) AND a.status = 'ready'
       AND ($2::boolean OR a.owner_subject = $3 OR a.owner_subject = $4
            OR EXISTS (SELECT 1 FROM content_revision_media rm JOIN content_revisions r ON r.id = rm.revision_id
                       WHERE rm.asset_id = a.id AND r.item_id = $5))
     FOR SHARE OF a`,
    [ids, seesAll(actor), actor.subject, item.ownerSubject, item.id],
  );
  const kinds = new Map(rows.map((r) => [r.id, r.kind]));
  const images = new Set<string>();
  const visit = (n: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    // Only uploaded images: an image from an address or SVG code has no asset.
    if (n.type === "image" && typeof n.attrs?.asset === "string") images.add(n.attrs.asset);
    for (const k of (n.content ?? []) as (typeof n)[]) visit(k);
  };
  visit(doc);
  const usable = ids.every((id) => kinds.has(id) && (!images.has(id) || kinds.get(id) === "image"));
  return usable ? { ok: true, ids } : { ok: false, error: "media_unavailable" };
}

/** With the revision, in the same transaction: the assets it uses. */
export async function recordRevisionMedia(c: Client, revisionId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await c.query(
    `INSERT INTO content_revision_media (revision_id, asset_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [revisionId, ids],
  );
}

/** A public revision uses it: an article's published revision, or a lesson of a published course (#358). */
const PUBLIC_USE = `
  EXISTS (SELECT 1 FROM content_revision_media rm JOIN content_items i ON i.published_revision_id = rm.revision_id
          WHERE rm.asset_id = a.id)
  OR EXISTS (SELECT 1 FROM content_revision_media rm
             JOIN course_lessons l ON l.item_revision_id = rm.revision_id
             JOIN courses co ON co.published_revision_id = l.revision_id
             JOIN content_items i ON i.id = l.item_id AND i.published_revision_id IS NOT NULL
             WHERE rm.asset_id = a.id)`;

/**
 * The asset `actor` (null for a guest) may read, with whether it is public; null otherwise (missing, not ready, or
 * not theirs to see: the caller answers 404 either way, so ids of private media leak nothing).
 */
export async function readableAsset(
  pool: Pick<Pool, "query">,
  actor: Actor | null,
  id: string,
): Promise<{ asset: MediaAsset; isPublic: boolean } | null> {
  if (!isAssetId(id)) return null;
  const row = (
    await pool.query<AssetRow & { is_public: boolean }>(
      `SELECT a.*, (${PUBLIC_USE}) AS is_public FROM media_assets a WHERE a.id = $1 AND a.status = 'ready'`,
      [id],
    )
  ).rows[0];
  if (!row) return null;
  const asset = toAsset(row);
  if (row.is_public) return { asset, isPublic: true };
  if (!actor) return null;
  if (actor.subject === asset.ownerSubject || seesAll(actor)) return { asset, isPublic: false };
  // Someone who may see an article that uses it (its owner, reading an editor's image in their own draft).
  const { rows } = await pool.query<{ owner_subject: string }>(
    `SELECT DISTINCT i.owner_subject FROM content_revision_media rm
     JOIN content_revisions r ON r.id = rm.revision_id JOIN content_items i ON i.id = r.item_id
     WHERE rm.asset_id = $1`,
    [id],
  );
  return rows.some((r) => canView(actor, { ownerSubject: r.owner_subject })) ? { asset, isPublic: false } : null;
}

export interface LibraryAsset extends MediaAsset {
  /** Revisions that use it; an asset in use can't be deleted. */
  uses: number;
}

/** The person's own ready assets, newest first, a page at a time, for the studio's media page and the editor's picker. */
export async function listLibrary(
  pool: Pick<Pool, "query">,
  actor: Actor,
  opts: { after?: string | null; limit?: number; kind?: MediaKind } = {},
): Promise<Page<LibraryAsset>> {
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE.studio, 1), 200);
  const after = decodeCursor(opts.after);
  const { rows } = await pool.query<AssetRow & { uses: number; at_key: string }>(
    `SELECT a.*, a.created_at::text AS at_key,
            (SELECT count(*)::int FROM content_revision_media rm WHERE rm.asset_id = a.id) AS uses
     FROM media_assets a
     WHERE a.owner_subject = $1 AND a.status = 'ready' AND ($2::text IS NULL OR a.kind = $2)
       AND ($3::timestamptz IS NULL OR (a.created_at, a.id) < ($3::timestamptz, $4::text))
     ORDER BY a.created_at DESC, a.id DESC LIMIT $5`,
    [actor.subject, opts.kind ?? null, after?.at ?? null, after?.id ?? null, limit + 1],
  );
  return pageOf(
    rows,
    limit,
    (r) => r.at_key,
    (r) => ({ ...toAsset(r), uses: r.uses }),
  );
}

/** Marked `deleting`: from here on nothing reads or uses it; its bytes and then its record go. */
const markDeleting = (c: Client, id: string) =>
  c.query("UPDATE media_assets SET status = 'deleting', checked_at = coalesce(checked_at, now()) WHERE id = $1", [id]);

/** The bytes, then the record. Throws (leaving the `deleting` record for cleanup) when the store fails. */
async function purge(pool: Pool, store: MediaStore, id: string): Promise<void> {
  await store.remove(assetKey(id));
  await store.remove(uploadKey(id));
  await pool.query("DELETE FROM media_assets WHERE id = $1 AND status = 'deleting'", [id]);
}

/** Delete one of the person's assets that no revision uses. */
export async function deleteAsset(
  pool: Pool,
  store: MediaStore,
  actor: Actor,
  id: string,
): Promise<MediaResult<object>> {
  if (!isAssetId(id)) return { ok: false, error: "not_found" };
  const claimed = await inTransaction(pool, async (c): Promise<MediaResult<object>> => {
    const row = (await c.query<AssetRow>("SELECT * FROM media_assets WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!row || row.status === "deleting" || (row.owner_subject !== actor.subject && !seesAll(actor)))
      return { ok: false, error: "not_found" } as const;
    const used = await c.query("SELECT 1 FROM content_revision_media WHERE asset_id = $1 LIMIT 1", [id]);
    if (used.rowCount) return { ok: false, error: "media_in_use" } as const;
    await markDeleting(c, id);
    await audit(c, `user:${actor.subject}`, "media.deleted", id);
    return { ok: true } as const;
  });
  if (!claimed.ok) return claimed;
  // Already gone for everyone; if the store fails now, cleanup finishes it.
  await purge(pool, store, id).catch(() => undefined);
  return { ok: true };
}

/**
 * Remove what nobody will use: uploads never finished (or rejected) after a day, ready assets no revision and no
 * autosaved draft has used for a week, and deletions a failure left half done. Returns how many assets went.
 */
export async function cleanupMedia(pool: Pool, store: MediaStore, now = new Date()): Promise<number> {
  const ids = await inTransaction(pool, async (c) => {
    const lock = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('knowledge.media.cleanup')) AS ok",
    );
    if (!lock.rows[0]!.ok) return [];
    const { rows } = await c.query<{ id: string; status: AssetStatus }>(
      `SELECT a.id, a.status FROM media_assets a
       WHERE a.status = 'deleting'
          OR (a.status IN ('pending', 'rejected') AND a.created_at < $1)
          OR (a.status = 'ready' AND a.created_at < $2
              AND NOT EXISTS (SELECT 1 FROM content_revision_media rm WHERE rm.asset_id = a.id)
              AND NOT EXISTS (SELECT 1 FROM draft_autosaves d WHERE strpos(d.doc::text, a.id) > 0))
       ORDER BY a.created_at LIMIT 500
       FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - CLEANUP_AGE.pending), new Date(now.getTime() - CLEANUP_AGE.unused)],
    );
    for (const r of rows) {
      if (r.status === "deleting") continue;
      await markDeleting(c, r.id);
      await audit(c, "system:cleanup", "media.deleted", r.id);
    }
    return rows.map((r) => r.id);
  });
  let removed = 0;
  for (const id of ids) {
    try {
      await purge(pool, store, id);
      removed += 1;
    } catch {
      // Stays `deleting`; the next run tries again.
    }
  }
  return removed;
}
