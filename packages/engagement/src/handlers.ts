/**
 * HTTP handlers for the engagement routes, as plain Web `Request` -> `Response` functions, so any app mounts them
 * in a Next.js route handler (or any fetch-style server) without this package knowing the framework:
 *
 *   // app/api/engagement/[...path]/route.ts
 *   const engagement = createEngagementHandlers({ service, salt, limiter, entities, resolveUser });
 *   export const GET = (req: Request) => engagement.handle(req);
 *   export const POST = GET; export const PATCH = GET; export const DELETE = GET;
 *
 * Routes (under `basePath`, default /api/engagement):
 *   GET    /likes           public; ?entityType=&entityId= -> { liked, count } for this person (or this guest)
 *   POST   /likes/toggle    public; rate limited per client address; a guest is told apart by a keyed visitor hash
 *   POST   /likes/sync      signed in; moves this browser's guest likes to the account (no double count)
 *   GET    /comments        public; ?entityType=&entityId=&limit=&offset=
 *   POST   /comments        signed in (and `canComment`, the app's permission check)
 *   PATCH  /comments/:id    the author
 *   DELETE /comments/:id    the author, or a moderator (`resolveUser` sets `canModerate`)
 *
 * The gateway may already refuse a guest on POST /comments (a manifest route with a permission); these handlers
 * check again, because the app must never trust that it is only reachable through the gateway.
 */
import { clientAddress, MIN_SALT_LENGTH, visitorHashOf } from "./visitor.ts";
import type { RateLimiter } from "./rate-limit.ts";
import {
  EngagementError,
  validateEntity,
  type EngagementService,
  type EngagementUser,
  type EntityRef,
} from "./service.ts";

/** What the app knows about one entity type. */
export interface EntityRule {
  /** Does this entity exist (and may be engaged with)? Without it, any id of the type is accepted. */
  exists?(entityId: string): Promise<boolean> | boolean;
}

export interface SessionUser extends EngagementUser {
  /** May delete other people's comments (the app decides: e.g. `knowledge.admin` or `core.admin`). */
  canModerate?: boolean;
}

export interface EngagementHandlersOptions {
  service: EngagementService;
  /** The per-app secret (ENGAGEMENT_SALT) for visitor hashes. At least 16 characters. */
  salt: string;
  /** Limits POST /likes/toggle per client address (15 a minute in the spec). */
  limiter: RateLimiter;
  /** The entity types this app lets people engage with, e.g. `{ lesson: { exists } }`. Anything else is refused. */
  entities: Record<string, EntityRule>;
  /** The signed-in person behind a request, or null for a guest. */
  resolveUser(request: Request): Promise<SessionUser | null> | SessionUser | null;
  /** The app's permission check for writing comments (e.g. `knowledge.comment.write`). Default: any signed-in person. */
  canComment?(user: SessionUser, request: Request): Promise<boolean> | boolean;
  /**
   * The badge cached with a new comment, when it depends on the entity (e.g. "instructor" on the course's own
   * lessons). Return null for no badge. Without it, `user.role` is used.
   */
  authorRole?(user: SessionUser, entity: EntityRef): Promise<string | null> | string | null;
  basePath?: string;
  /**
   * This site's origin as the visitor sees it (e.g. "https://learn.asafarim.site"), for the cross-site check on
   * every POST, PATCH and DELETE: a request whose `Origin` names another site, or that the browser marks
   * `Sec-Fetch-Site: cross-site`, is refused with 403 before anything is read. A request without either header (not
   * a browser) is let through: it carries no ambient session to abuse. Without this option, only Sec-Fetch-Site is
   * checked.
   */
  siteOrigin?(request: Request): string | null | undefined;
  /** Where unexpected errors go. Default: one JSON line on stderr, never the request body. */
  log?(message: string, detail: Record<string, unknown>): void;
}

const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function errorResponse(err: EngagementError, headers: Record<string, string> = {}): Response {
  return json({ error: { code: err.code, message: err.message } }, err.status, headers);
}

/**
 * The body as text, read as a stream and stopped once it passes MAX_BODY_BYTES, so a request without (or lying
 * about) Content-Length can never make the server buffer more than the limit.
 */
async function readCapped(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new EngagementError("payload_too_large", "request body too large", 413);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new EngagementError("payload_too_large", "request body too large", 413);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await readCapped(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EngagementError("invalid_request", "the body must be JSON", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngagementError("invalid_request", "the body must be a JSON object", 400);
  }
  return parsed as Record<string, unknown>;
}

/** Remove trailing slashes in one linear pass (a regex like /\/+$/ backtracks quadratically on long runs of "/"). */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

function intParam(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

export function createEngagementHandlers(options: EngagementHandlersOptions) {
  if (typeof options.salt !== "string" || options.salt.length < MIN_SALT_LENGTH) {
    throw new Error(`ENGAGEMENT_SALT must be set to at least ${MIN_SALT_LENGTH} characters`);
  }
  const basePath = trimTrailingSlashes(options.basePath ?? "/api/engagement");
  const log =
    options.log ??
    ((message, detail) =>
      console.error(JSON.stringify({ app: "engagement", level: "error", msg: message, ...detail })));

  async function entityOf(source: { entityType?: unknown; entityId?: unknown }): Promise<EntityRef> {
    const ref = { entityType: source.entityType as string, entityId: source.entityId as string };
    validateEntity(ref);
    const rule = Object.hasOwn(options.entities, ref.entityType) ? options.entities[ref.entityType] : undefined;
    if (!rule) throw new EngagementError("invalid_entity", "unknown entityType", 400);
    if (rule.exists && !(await rule.exists(ref.entityId))) {
      throw new EngagementError("not_found", "entity not found", 404);
    }
    return ref;
  }

  async function requireUser(request: Request): Promise<SessionUser> {
    const user = await options.resolveUser(request);
    if (!user) throw new EngagementError("unauthorized", "sign in first", 401);
    return user;
  }

  /** Refuse a write a browser sent from another site (CSRF), before reading anything. */
  function sameSite(request: Request): void {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new EngagementError("forbidden", "cross-site request refused", 403);
    }
    const origin = request.headers.get("origin");
    if (!origin || !options.siteOrigin) return;
    const expected = options.siteOrigin(request);
    if (expected && origin !== expected) throw new EngagementError("forbidden", "cross-site request refused", 403);
  }

  async function guarded(fn: () => Promise<Response>, request: Request): Promise<Response> {
    try {
      sameSite(request);
      return await fn();
    } catch (err) {
      if (err instanceof EngagementError) return errorResponse(err);
      log("engagement.unhandled", {
        method: request.method,
        path: new URL(request.url).pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return json({ error: { code: "internal", message: "something went wrong" } }, 500);
    }
  }

  const handlers = {
    toggleLike: (request: Request): Promise<Response> =>
      guarded(async () => {
        // First, before reading anything: a flood costs one Redis call, not a database transaction.
        const limit = await options.limiter.hit(`likes-toggle:${clientAddress(request.headers)}`);
        if (!limit.ok) {
          return errorResponse(new EngagementError("rate_limited", "too many requests, slow down", 429), {
            "retry-after": String(limit.retryAfterSeconds),
          });
        }
        const body = await readJson(request);
        const entity = await entityOf(body);
        const user = await options.resolveUser(request);
        const actor = user ? { userId: user.id } : { visitorHash: visitorHashOf(request.headers, options.salt) };
        return json(await options.service.toggleLike(entity, actor));
      }, request),

    syncLikes: (request: Request): Promise<Response> =>
      guarded(async () => {
        const user = await requireUser(request);
        // Same budget as toggling: a sync is cheap for a visitor with no guest likes, bounded for one with many.
        const limit = await options.limiter.hit(`likes-sync:${clientAddress(request.headers)}`);
        if (!limit.ok) {
          return errorResponse(new EngagementError("rate_limited", "too many requests, slow down", 429), {
            "retry-after": String(limit.retryAfterSeconds),
          });
        }
        return json(await options.service.syncGuestLikes(visitorHashOf(request.headers, options.salt), user.id));
      }, request),

    likeState: (request: Request): Promise<Response> =>
      guarded(async () => {
        const q = new URL(request.url).searchParams;
        const entity = await entityOf({ entityType: q.get("entityType"), entityId: q.get("entityId") });
        const user = await options.resolveUser(request);
        const actor = user ? { userId: user.id } : { visitorHash: visitorHashOf(request.headers, options.salt) };
        return json(await options.service.likeState(entity, actor));
      }, request),

    listComments: (request: Request): Promise<Response> =>
      guarded(async () => {
        const q = new URL(request.url).searchParams;
        const entity = await entityOf({ entityType: q.get("entityType"), entityId: q.get("entityId") });
        const page: { limit?: number; offset?: number } = {};
        const limit = intParam(q.get("limit"));
        const offset = intParam(q.get("offset"));
        if (limit !== undefined) page.limit = limit;
        if (offset !== undefined) page.offset = offset;
        return json(await options.service.listComments(entity, page));
      }, request),

    createComment: (request: Request): Promise<Response> =>
      guarded(async () => {
        const user = await requireUser(request);
        if (options.canComment && !(await options.canComment(user, request))) {
          throw new EngagementError("forbidden", "you may not comment", 403);
        }
        const body = await readJson(request);
        const entity = await entityOf(body);
        const parentId = body.parentId;
        if (parentId !== undefined && parentId !== null && typeof parentId !== "string") {
          throw new EngagementError("invalid_parent", "parentId must be a comment id", 400);
        }
        const author = options.authorRole ? { ...user, role: await options.authorRole(user, entity) } : user;
        const comment = await options.service.createComment({
          entity,
          user: author,
          body: body.body as string,
          parentId: parentId ?? null,
        });
        return json({ comment }, 201);
      }, request),

    editComment: (request: Request, id: string): Promise<Response> =>
      guarded(async () => {
        const user = await requireUser(request);
        // Editing is writing: someone whose comment permission was taken away can't change what they wrote. (They
        // may still delete their own comments.)
        if (options.canComment && !(await options.canComment(user, request))) {
          throw new EngagementError("forbidden", "you may not comment", 403);
        }
        const body = await readJson(request);
        const comment = await options.service.editComment({ id, userId: user.id, body: body.body as string });
        return json({ comment });
      }, request),

    deleteComment: (request: Request, id: string): Promise<Response> =>
      guarded(async () => {
        const user = await requireUser(request);
        return json(
          await options.service.deleteComment({ id, userId: user.id, canModerate: user.canModerate === true }),
        );
      }, request),

    /** Dispatch a request under `basePath` to the handler above. */
    handle(request: Request): Promise<Response> {
      const path = trimTrailingSlashes(new URL(request.url).pathname);
      const method = request.method.toUpperCase();
      const notFound = () => Promise.resolve(json({ error: { code: "not_found", message: "no such route" } }, 404));
      const notAllowed = (allow: string) =>
        Promise.resolve(json({ error: { code: "invalid_request", message: "method not allowed" } }, 405, { allow }));
      if (!path.startsWith(`${basePath}/`)) return notFound();
      const route = path.slice(basePath.length);

      if (route === "/likes")
        return method === "GET" || method === "HEAD" ? handlers.likeState(request) : notAllowed("GET");
      if (route === "/likes/sync") return method === "POST" ? handlers.syncLikes(request) : notAllowed("POST");
      if (route === "/likes/toggle") return method === "POST" ? handlers.toggleLike(request) : notAllowed("POST");
      if (route === "/comments") {
        if (method === "GET") return handlers.listComments(request);
        if (method === "POST") return handlers.createComment(request);
        return notAllowed("GET, POST");
      }
      const m = /^\/comments\/([^/]+)$/.exec(route);
      if (m) {
        const id = m[1]!;
        if (!UUID.test(id)) return notFound();
        if (method === "PATCH") return handlers.editComment(request, id);
        if (method === "DELETE") return handlers.deleteComment(request, id);
        return notAllowed("PATCH, DELETE");
      }
      return notFound();
    },
  };
  return handlers;
}

export type EngagementHandlers = ReturnType<typeof createEngagementHandlers>;
