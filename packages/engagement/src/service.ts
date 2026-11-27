/**
 * The engagement service: likes and comments in the host app's own Postgres.
 *
 * Every write runs in ONE transaction together with the app's `onCountChange` hook, so a rolled-up counter (a
 * lesson's, a module's, a course's) can never disagree with the rows it counts: if the hook throws, the like or
 * comment is rolled back with it. The hook is told only about REAL changes: a like that already existed, or a
 * delete that removed nothing, calls it with no delta at all, which is what stops a double count.
 */
import type { Pool, PoolClient } from "pg";

export type CountMetric = "likes" | "comments";

/**
 * Called inside the transaction of the write that caused it, with `delta` = +1 / -1 (likes) or the number of visible
 * comments added / removed. `tx` is the open transaction: run the app's rollup UPDATEs on it.
 */
export type OnCountChange = (
  entityType: string,
  entityId: string,
  metric: CountMetric,
  delta: number,
  tx: PoolClient,
) => Promise<void> | void;

export interface EntityRef {
  entityType: string;
  entityId: string;
}

/** The person writing a comment (from the app's session), and what is cached into `author_snapshot`. */
export interface EngagementUser {
  id: string;
  name: string;
  avatarUrl?: string | null;
  /** A badge to show next to the name, e.g. "instructor" or "admin". */
  role?: string | null;
}

export type LikeActor = { userId: string } | { visitorHash: string };

export type EngagementErrorCode =
  | "invalid_entity"
  | "invalid_body"
  | "invalid_request"
  | "invalid_parent"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "conflict"
  | "payload_too_large";

export class EngagementError extends Error {
  constructor(
    readonly code: EngagementErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EngagementError";
  }
}

export const MAX_COMMENT_LENGTH = 2000;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

const ENTITY_TYPE = /^[a-z][a-z0-9_]{0,49}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISITOR_HASH = /^[0-9a-f]{64}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function validateEntity(ref: EntityRef): void {
  if (typeof ref.entityType !== "string" || !ENTITY_TYPE.test(ref.entityType)) {
    throw new EngagementError("invalid_entity", "entityType must be 1-50 lower-case letters, digits or _", 400);
  }
  if (typeof ref.entityId !== "string" || ref.entityId.length < 1 || ref.entityId.length > 128) {
    throw new EngagementError("invalid_entity", "entityId must be 1-128 characters", 400);
  }
}

function validateActor(actor: LikeActor): void {
  if ("userId" in actor) {
    if (typeof actor.userId !== "string" || actor.userId.length < 1 || actor.userId.length > 256) {
      throw new EngagementError("unauthorized", "invalid user", 401);
    }
  } else if (typeof actor.visitorHash !== "string" || !VISITOR_HASH.test(actor.visitorHash)) {
    throw new EngagementError("invalid_request", "invalid visitor hash", 400);
  }
}

/** A comment body as it will be stored: trimmed, 1..2000 characters (code points, as the database counts). */
export function normalizeBody(raw: unknown): string {
  if (typeof raw !== "string") throw new EngagementError("invalid_body", "body must be text", 400);
  if (raw.includes("\u0000")) throw new EngagementError("invalid_body", "body contains an invalid character", 400);
  const body = raw.trim();
  if (body.length === 0) throw new EngagementError("invalid_body", "body must not be empty", 400);
  if ([...body].length > MAX_COMMENT_LENGTH) {
    throw new EngagementError("invalid_body", `body must be at most ${MAX_COMMENT_LENGTH} characters`, 400);
  }
  return body;
}

export interface AuthorSnapshot {
  name: string;
  avatar_url: string | null;
  role: string | null;
}

/** What is stored in author_snapshot: bounded strings, and an avatar only if it is an http(s) URL. */
export function snapshotOf(user: Pick<EngagementUser, "name" | "avatarUrl" | "role">): AuthorSnapshot {
  const name =
    String(user.name ?? "")
      .trim()
      .slice(0, 200) || "Anonymous";
  let avatar: string | null = null;
  if (user.avatarUrl) {
    try {
      const url = new URL(user.avatarUrl);
      if ((url.protocol === "https:" || url.protocol === "http:") && user.avatarUrl.length <= 2048) {
        avatar = url.toString();
      }
    } catch {
      /* not a URL: no avatar */
    }
  }
  const role = user.role ? String(user.role).trim().slice(0, 50) || null : null;
  return { name, avatar_url: avatar, role };
}

export interface Comment {
  id: string;
  entityType: string;
  entityId: string;
  userId: string;
  author: { name: string; avatarUrl: string | null; role: string | null };
  parentId: string | null;
  body: string;
  isPinned: boolean;
  status: "visible" | "hidden" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface CommentThread extends Comment {
  replies: Comment[];
}

interface CommentRow {
  id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  author_snapshot: Partial<AuthorSnapshot> | null;
  parent_id: string | null;
  body: string;
  is_pinned: boolean;
  status: Comment["status"];
  created_at: Date;
  updated_at: Date;
}

function toComment(r: CommentRow): Comment {
  const s = r.author_snapshot ?? {};
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    userId: r.user_id,
    author: { name: s.name ?? "Anonymous", avatarUrl: s.avatar_url ?? null, role: s.role ?? null },
    parentId: r.parent_id,
    body: r.body,
    isPinned: r.is_pinned,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface EngagementServiceOptions {
  pool: Pool;
  onCountChange?: OnCountChange;
  /**
   * Called inside the transaction of a new comment or reply, after the count hook: publish an event through the
   * app's outbox here (e.g. `knowledge.comment.created.v1`). Throwing rolls the comment back.
   */
  onCommentCreated?: (comment: Comment, tx: PoolClient) => Promise<void> | void;
}

/** At most this many guest likes move to an account in one sync (a guest liking more is not a person). */
export const MAX_SYNC_LIKES = 500;

const likeLockKey = (entity: EntityRef, who: string) => `${entity.entityType}\n${entity.entityId}\n${who}`;

async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  let broken: Error | undefined;
  try {
    await tx.query("BEGIN");
    try {
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (err) {
      await tx.query("ROLLBACK").catch((e: unknown) => {
        // The connection is in an unknown state: have the pool discard it instead of reusing it.
        broken = e instanceof Error ? e : new Error(String(e));
      });
      throw err;
    }
  } finally {
    tx.release(broken);
  }
}

export function createEngagementService(options: EngagementServiceOptions) {
  const { pool } = options;
  const notify = async (tx: PoolClient, entity: EntityRef, metric: CountMetric, delta: number): Promise<void> => {
    if (delta !== 0) await options.onCountChange?.(entity.entityType, entity.entityId, metric, delta, tx);
  };

  const countLikes = async (db: Pick<Pool, "query">, entity: EntityRef): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM engagement_likes WHERE entity_type = $1 AND entity_id = $2",
      [entity.entityType, entity.entityId],
    );
    return rows[0]?.n ?? 0;
  };

  return {
    /**
     * Like if the actor has not liked, unlike if they have. Toggles of the same (entity, actor) run one at a time
     * (advisory lock), so the hook only ever sees a change that really happened and a race cannot double count.
     */
    async toggleLike(entity: EntityRef, actor: LikeActor): Promise<{ liked: boolean; count: number }> {
      validateEntity(entity);
      validateActor(actor);
      const who = "userId" in actor ? `u:${actor.userId}` : `v:${actor.visitorHash}`;
      return withTransaction(pool, async (tx) => {
        // One toggle at a time per (entity, actor): requests racing for the same like would otherwise keep
        // undoing each other. Other actors do not wait for this one. The unique indexes stay as the backstop.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [likeLockKey(entity, who)]);
        const removed =
          "userId" in actor
            ? await tx.query(
                "DELETE FROM engagement_likes WHERE entity_type = $1 AND entity_id = $2 AND user_id = $3 RETURNING id",
                [entity.entityType, entity.entityId, actor.userId],
              )
            : await tx.query(
                `DELETE FROM engagement_likes WHERE entity_type = $1 AND entity_id = $2 AND visitor_hash = $3
                   AND user_id IS NULL RETURNING id`,
                [entity.entityType, entity.entityId, actor.visitorHash],
              );
        if (removed.rowCount === 1) {
          await notify(tx, entity, "likes", -1);
          return { liked: false, count: await countLikes(tx, entity) };
        }
        const inserted =
          "userId" in actor
            ? await tx.query(
                `INSERT INTO engagement_likes (entity_type, entity_id, user_id) VALUES ($1, $2, $3)
                 ON CONFLICT (entity_type, entity_id, user_id) WHERE user_id IS NOT NULL DO NOTHING RETURNING id`,
                [entity.entityType, entity.entityId, actor.userId],
              )
            : await tx.query(
                `INSERT INTO engagement_likes (entity_type, entity_id, visitor_hash) VALUES ($1, $2, $3)
                 ON CONFLICT (entity_type, entity_id, visitor_hash) WHERE user_id IS NULL DO NOTHING RETURNING id`,
                [entity.entityType, entity.entityId, actor.visitorHash],
              );
        if (inserted.rowCount !== 1) {
          throw new EngagementError("conflict", "could not toggle the like, try again", 409);
        }
        await notify(tx, entity, "likes", 1);
        return { liked: true, count: await countLikes(tx, entity) };
      });
    },

    /**
     * Give a person the likes they made as a guest (the same visitor hash) before signing in. A like they had
     * already made signed in is not counted twice: the guest one is dropped (count -1); any other becomes theirs
     * (count unchanged). Runs under the same per-(entity, actor) locks as toggleLike, so a toggle racing it cannot
     * double count either. Returns how many likes were moved and how many were merged into an existing one.
     */
    async syncGuestLikes(visitorHash: string, userId: string): Promise<{ moved: number; merged: number }> {
      validateActor({ visitorHash });
      validateActor({ userId });
      return withTransaction(pool, async (tx) => {
        // One sync per visitor at a time (a second tab signing in at once waits, then finds nothing left).
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`sync\n${visitorHash}`]);
        const { rows } = await tx.query<{ entity_type: string; entity_id: string }>(
          `SELECT entity_type, entity_id FROM engagement_likes WHERE visitor_hash = $1 AND user_id IS NULL
            ORDER BY entity_type, entity_id LIMIT $2`,
          [visitorHash, MAX_SYNC_LIKES],
        );
        if (rows.length === 0) return { moved: 0, merged: 0 };
        const entities = rows.map((r) => ({ entityType: r.entity_type, entityId: r.entity_id }));
        // The same locks toggleLike takes, in one sorted order, so two syncs of one person can't deadlock.
        const keys = entities
          .flatMap((e) => [likeLockKey(e, `u:${userId}`), likeLockKey(e, `v:${visitorHash}`)])
          .sort();
        for (const key of keys) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        let moved = 0;
        let merged = 0;
        for (const entity of entities) {
          const own = await tx.query(
            "SELECT 1 FROM engagement_likes WHERE entity_type = $1 AND entity_id = $2 AND user_id = $3",
            [entity.entityType, entity.entityId, userId],
          );
          if ((own.rowCount ?? 0) > 0) {
            const gone = await tx.query(
              `DELETE FROM engagement_likes WHERE entity_type = $1 AND entity_id = $2 AND visitor_hash = $3
                 AND user_id IS NULL`,
              [entity.entityType, entity.entityId, visitorHash],
            );
            if (gone.rowCount === 1) {
              merged++;
              await notify(tx, entity, "likes", -1);
            }
          } else {
            const moves = await tx.query(
              `UPDATE engagement_likes SET user_id = $4, visitor_hash = NULL
                WHERE entity_type = $1 AND entity_id = $2 AND visitor_hash = $3 AND user_id IS NULL`,
              [entity.entityType, entity.entityId, visitorHash, userId],
            );
            moved += moves.rowCount ?? 0;
          }
        }
        return { moved, merged };
      });
    },

    /** The like count of an entity and whether `actor` (if any) has liked it. */
    async likeState(entity: EntityRef, actor?: LikeActor): Promise<{ liked: boolean; count: number }> {
      validateEntity(entity);
      const count = await countLikes(pool, entity);
      if (!actor) return { liked: false, count };
      validateActor(actor);
      const { rowCount } =
        "userId" in actor
          ? await pool.query(
              "SELECT 1 FROM engagement_likes WHERE entity_type = $1 AND entity_id = $2 AND user_id = $3",
              [entity.entityType, entity.entityId, actor.userId],
            )
          : await pool.query(
              `SELECT 1 FROM engagement_likes WHERE entity_type = $1 AND entity_id = $2 AND visitor_hash = $3
                 AND user_id IS NULL`,
              [entity.entityType, entity.entityId, actor.visitorHash],
            );
      return { liked: rowCount === 1, count };
    },

    /** Add a comment, or a reply when `parentId` is given (one level only). Counts +1 "comments". */
    async createComment(input: {
      entity: EntityRef;
      user: EngagementUser;
      body: string;
      parentId?: string | null;
    }): Promise<Comment> {
      validateEntity(input.entity);
      const body = normalizeBody(input.body);
      if (typeof input.user?.id !== "string" || input.user.id.length < 1 || input.user.id.length > 256) {
        throw new EngagementError("unauthorized", "sign in to comment", 401);
      }
      const parentId = input.parentId ?? null;
      if (parentId !== null && !isUuid(parentId)) {
        throw new EngagementError("invalid_parent", "parentId is not a comment id", 400);
      }
      return withTransaction(pool, async (tx) => {
        if (parentId !== null) {
          // FOR SHARE: a concurrent hard delete of the parent waits for this reply, instead of orphaning it.
          const { rows } = await tx.query<Pick<CommentRow, "parent_id" | "entity_type" | "entity_id" | "status">>(
            "SELECT parent_id, entity_type, entity_id, status FROM engagement_comments WHERE id = $1 FOR SHARE",
            [parentId],
          );
          const parent = rows[0];
          if (
            !parent ||
            parent.status !== "visible" ||
            parent.entity_type !== input.entity.entityType ||
            parent.entity_id !== input.entity.entityId
          ) {
            throw new EngagementError("invalid_parent", "the comment you reply to does not exist", 400);
          }
          if (parent.parent_id !== null) {
            throw new EngagementError("invalid_parent", "replies can only be one level deep", 400);
          }
        }
        const { rows } = await tx.query<CommentRow>(
          `INSERT INTO engagement_comments (entity_type, entity_id, user_id, author_snapshot, parent_id, body)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`,
          [
            input.entity.entityType,
            input.entity.entityId,
            input.user.id,
            JSON.stringify(snapshotOf(input.user)),
            parentId,
            body,
          ],
        );
        await notify(tx, input.entity, "comments", 1);
        const comment = toComment(rows[0]!);
        await options.onCommentCreated?.(comment, tx);
        return comment;
      });
    },

    /** Change the body of your own visible comment. */
    async editComment(input: { id: string; userId: string; body: string }): Promise<Comment> {
      const body = normalizeBody(input.body);
      if (!isUuid(input.id)) throw new EngagementError("not_found", "comment not found", 404);
      const { rows } = await pool.query<CommentRow>(
        `UPDATE engagement_comments SET body = $3, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status = 'visible' RETURNING *`,
        [input.id, input.userId, body],
      );
      if (rows[0]) return toComment(rows[0]);
      const existing = await pool.query<Pick<CommentRow, "status">>(
        "SELECT status FROM engagement_comments WHERE id = $1",
        [input.id],
      );
      if (existing.rows[0]?.status !== "visible") throw new EngagementError("not_found", "comment not found", 404);
      throw new EngagementError("forbidden", "you can only edit your own comments", 403);
    },

    /**
     * Hard-delete a comment and its replies (author, or a moderator). Counts -N "comments", N being the visible
     * rows that went (the comment, if visible, and its visible replies).
     */
    async deleteComment(input: { id: string; userId: string; canModerate?: boolean }): Promise<{ removed: number }> {
      if (!isUuid(input.id)) throw new EngagementError("not_found", "comment not found", 404);
      return withTransaction(pool, async (tx) => {
        // FOR UPDATE serialises with a reply being added (which takes FOR SHARE on this row).
        const { rows } = await tx.query<Pick<CommentRow, "user_id" | "entity_type" | "entity_id" | "status">>(
          "SELECT user_id, entity_type, entity_id, status FROM engagement_comments WHERE id = $1 FOR UPDATE",
          [input.id],
        );
        const row = rows[0];
        if (!row) throw new EngagementError("not_found", "comment not found", 404);
        if (row.user_id !== input.userId && !input.canModerate) {
          throw new EngagementError("forbidden", "you can only delete your own comments", 403);
        }
        // Lock the replies that will go with it and count only those: a reply being deleted by someone else at the
        // same moment holds its row, so this waits for that delete and then no longer sees the reply. Counting
        // without the lock counted that reply in both deletes, and the rollups lost one comment too many.
        const replies = await tx.query(
          "SELECT id FROM engagement_comments WHERE parent_id = $1 AND status = 'visible' FOR UPDATE",
          [input.id],
        );
        await tx.query("DELETE FROM engagement_comments WHERE id = $1", [input.id]);
        const removed = (row.status === "visible" ? 1 : 0) + (replies.rowCount ?? 0);
        await notify(tx, { entityType: row.entity_type, entityId: row.entity_id }, "comments", -removed);
        return { removed };
      });
    },

    /**
     * The visible comments of an entity: top-level ones, pinned first and then oldest first, each with its visible
     * replies (oldest first). `total` counts the top-level comments, for paging.
     */
    async listComments(
      entity: EntityRef,
      page: { limit?: number; offset?: number } = {},
    ): Promise<{ comments: CommentThread[]; total: number }> {
      validateEntity(entity);
      const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
      const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
      const [top, total] = await Promise.all([
        pool.query<CommentRow>(
          `SELECT * FROM engagement_comments
            WHERE entity_type = $1 AND entity_id = $2 AND parent_id IS NULL AND status = 'visible'
            ORDER BY is_pinned DESC, created_at ASC, id ASC LIMIT $3 OFFSET $4`,
          [entity.entityType, entity.entityId, limit, offset],
        ),
        pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM engagement_comments
            WHERE entity_type = $1 AND entity_id = $2 AND parent_id IS NULL AND status = 'visible'`,
          [entity.entityType, entity.entityId],
        ),
      ]);
      const replies = new Map<string, Comment[]>();
      if (top.rows.length > 0) {
        const { rows } = await pool.query<CommentRow>(
          `SELECT * FROM engagement_comments WHERE parent_id = ANY($1::uuid[]) AND status = 'visible'
            ORDER BY created_at ASC, id ASC`,
          [top.rows.map((r) => r.id)],
        );
        for (const r of rows) {
          const list = replies.get(r.parent_id!) ?? [];
          list.push(toComment(r));
          replies.set(r.parent_id!, list);
        }
      }
      return {
        comments: top.rows.map((r) => ({ ...toComment(r), replies: replies.get(r.id) ?? [] })),
        total: total.rows[0]?.n ?? 0,
      };
    },

    /**
     * Refresh the cached author of every comment by `userId` (call it from the handler of an identity "profile
     * changed" event). Returns the number of comments changed.
     */
    async updateAuthorSnapshot(
      userId: string,
      user: Pick<EngagementUser, "name" | "avatarUrl" | "role">,
    ): Promise<number> {
      const { rowCount } = await pool.query(
        `UPDATE engagement_comments SET author_snapshot = $2::jsonb
          WHERE user_id = $1 AND author_snapshot IS DISTINCT FROM $2::jsonb`,
        [userId, JSON.stringify(snapshotOf(user))],
      );
      return rowCount ?? 0;
    },
  };
}

export type EngagementService = ReturnType<typeof createEngagementService>;
