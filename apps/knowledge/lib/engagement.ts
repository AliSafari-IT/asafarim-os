/**
 * Likes and comments on published content (@asafarim/engagement), mounted at /api/engagement/** (app/api/engagement/[...path]).
 *
 * - Anyone may like a published article, guests too (told apart by a keyed visitor hash), 15 toggles a minute per address.
 * - Anyone may read comments. Writing one needs `knowledge.comment.write`; deleting someone else's needs
 *   `knowledge.comment.moderate`. Both are checked here, by the app, on every request, never left to the gateway:
 *   the gateway answers a POST whose 60 s access token expired with 401 and no renewal (#363), which would drop a
 *   comment a reader took a minute to write.
 * - Engagement belongs to a published article, including every lesson that presents it.
 * - Course and module totals read the distinct articles in their published outlines (lib/engagement-rollups.ts).
 *
 * - A new comment publishes knowledge.comment.created.v2 through the outbox (lib/events.ts), in its transaction.
 * - Writes from another site are refused (Origin / Sec-Fetch-Site), and a signed-in person's guest likes move to
 *   their account (POST /likes/sync, sent by <GuestLikeSync> in either view).
 *
 * ENGAGEMENT_SALT is required: without it the routes answer 503 and the pages show no like or comment UI.
 */
import "server-only";
import {
  createEngagementHandlers,
  createEngagementService,
  createMemoryRateLimiter,
  type EngagementHandlers,
  type SessionUser,
} from "@asafarim/engagement";
import { visitorOrigin } from "@asafarim/app-sdk";
import { auth } from "./auth";
import { db } from "./db";
import { applyCountChange, isPublicArticle, resolveLessonArticle } from "./engagement-rollups";
import { publishCommentCreated } from "./events";
import { engagementSalt } from "./engagement-config";
import { describeAccess, gate } from "./gate";
import { PERMISSIONS } from "./policy";

export const ENGAGEMENT_BASE_PATH = "/api/engagement";

export { engagementEnabled } from "./engagement-config";

/** The signed-in person as the engagement routes see them, or null for a guest. */
async function sessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const access = await describeAccess(id);
  return {
    id,
    name: session.user?.name || "Reader",
    avatarUrl: session.user?.image ?? null,
    canModerate: access.permissions.includes(PERMISSIONS.commentModerate),
  };
}

/** What the lesson page offers the person: may they write, may they moderate. Null for a guest. */
export async function commentViewer(): Promise<{ id: string; canComment: boolean; canModerate: boolean } | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const access = await describeAccess(id);
  return {
    id,
    canComment: access.state === "active" && access.permissions.includes(PERMISSIONS.commentWrite),
    canModerate: access.permissions.includes(PERMISSIONS.commentModerate),
  };
}

const g = globalThis as unknown as {
  knowledgeEngagement?: { salt: string; handlers: Promise<EngagementHandlers> };
};

async function build(s: string): Promise<EngagementHandlers> {
  const pool = await db(); // migrated: Knowledge's tables and the engagement module's
  const service = createEngagementService({
    pool,
    onCountChange: (type, id, metric, delta, tx) => applyCountChange(tx, type, id, metric, delta),
    // knowledge.comment.created.v2, in the comment's own transaction (identifiers only, never the text).
    onCommentCreated: (comment, tx) => publishCommentCreated(tx, comment),
  });
  return createEngagementHandlers({
    service,
    salt: s,
    // One Knowledge instance (as for search, lib/rate-limit.ts): an in-process limit is enough.
    limiter: createMemoryRateLimiter({ limit: 15, windowMs: 60_000 }),
    entities: {
      lesson: { resolve: (id) => resolveLessonArticle(pool, id) },
      article: { exists: (id) => isPublicArticle(pool, id) },
    },
    basePath: ENGAGEMENT_BASE_PATH,
    // Writes from another site are refused (CSRF): the visitor's origin, as the gateway forwards it.
    siteOrigin: (request) => visitorOrigin(request.headers),
    resolveUser: () => sessionUser(),
    // The app's own check: signed in, the app active, the permission held (from core-api, as for the studio).
    canComment: async () => (await gate(PERMISSIONS.commentWrite)).ok,
    authorRole: async (user, entity) => {
      const owner = await pool.query(
        `SELECT 1 FROM courses c JOIN course_lessons l ON l.revision_id=c.published_revision_id
         WHERE l.item_id=$1 AND c.owner_subject=$2 LIMIT 1`,
        [entity.entityId, user.id],
      );
      if (owner.rowCount) return "instructor";
      return user.canModerate ? "moderator" : null;
    },
    log: (message, detail) =>
      console.error(JSON.stringify({ app: "knowledge", level: "error", msg: message, ...detail })),
  });
}

/** The handlers, built once per process; null when ENGAGEMENT_SALT is missing. */
export function engagementHandlers(): Promise<EngagementHandlers> | null {
  const s = engagementSalt();
  if (!s) return null;
  if (g.knowledgeEngagement?.salt !== s) {
    const handlers = build(s);
    // A failed build (the database down at first use) is retried on the next request.
    handlers.catch(() => {
      if (g.knowledgeEngagement?.handlers === handlers) g.knowledgeEngagement = undefined;
    });
    g.knowledgeEngagement = { salt: s, handlers };
  }
  return g.knowledgeEngagement.handlers;
}
