/**
 * The browser side of the engagement routes (src/handlers.ts): small fetch wrappers that turn every answer into a
 * value or an `EngagementApiError` the components can show. No React here, so it is testable on its own.
 */

/** A comment as the routes return it (the JSON of `Comment` from src/service.ts). */
export interface ClientComment {
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

export interface ClientThread extends ClientComment {
  replies: ClientComment[];
}

export interface LikeState {
  liked: boolean;
  count: number;
}

export interface EntityTarget {
  entityType: string;
  entityId: string;
}

export const DEFAULT_BASE_PATH = "/api/engagement";

export class EngagementApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds to wait, from Retry-After on a 429. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "EngagementApiError";
  }
}

type Fetch = typeof fetch;

async function call<T>(fetcher: Fetch, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    });
  } catch {
    throw new EngagementApiError(0, "network", "Could not reach the server. Check your connection and try again.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON (a gateway page, say): handled below */
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const retry = Number(res.headers.get("retry-after"));
    throw new EngagementApiError(
      res.status,
      typeof err?.code === "string" ? err.code : "http_error",
      typeof err?.message === "string" ? err.message : `The server answered ${res.status}.`,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return body as T;
}

const query = (t: EntityTarget, extra: Record<string, string> = {}) =>
  new URLSearchParams({ entityType: t.entityType, entityId: t.entityId, ...extra }).toString();

export function createEngagementClient(options: { basePath?: string; fetch?: Fetch } = {}) {
  const base = (options.basePath ?? DEFAULT_BASE_PATH).replace(/\/$/, "");
  const fetcher: Fetch = options.fetch ?? ((...args) => fetch(...args));
  return {
    likeState: (t: EntityTarget) => call<LikeState>(fetcher, `${base}/likes?${query(t)}`),
    toggleLike: (t: EntityTarget) =>
      call<LikeState>(fetcher, `${base}/likes/toggle`, { method: "POST", body: JSON.stringify(t) }),
    listComments: (t: EntityTarget, page: { limit?: number; offset?: number } = {}) => {
      const extra: Record<string, string> = {};
      if (page.limit !== undefined) extra.limit = String(page.limit);
      if (page.offset !== undefined) extra.offset = String(page.offset);
      return call<{ comments: ClientThread[]; total: number }>(fetcher, `${base}/comments?${query(t, extra)}`);
    },
    createComment: (t: EntityTarget, body: string, parentId: string | null = null) =>
      call<{ comment: ClientComment }>(fetcher, `${base}/comments`, {
        method: "POST",
        body: JSON.stringify({ ...t, body, parentId }),
      }),
    editComment: (id: string, body: string) =>
      call<{ comment: ClientComment }>(fetcher, `${base}/comments/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      }),
    deleteComment: (id: string) =>
      call<{ removed: number }>(fetcher, `${base}/comments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
}

export type EngagementClient = ReturnType<typeof createEngagementClient>;

/** "1.2k" style, for badges: exact below 1000. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const whole = Math.trunc(n);
  if (whole < 1000) return String(whole);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, unit] of units) {
    if (whole >= size) {
      const v = Math.floor((whole / size) * 10) / 10;
      return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}${unit}`;
    }
  }
  return String(whole);
}

/**
 * The guest's own memory of what they liked (the brief's "localStorage on the client"): only a hint shown before the
 * server answers, never trusted. Storage may be missing or throw (private windows); then nothing is remembered.
 */
export const likedHint = {
  key: (t: EntityTarget) => `asafarim.engagement.liked:${t.entityType}:${t.entityId}`,
  read(t: EntityTarget): boolean | null {
    try {
      const v = globalThis.localStorage?.getItem(likedHint.key(t));
      return v === "1" ? true : v === "0" ? false : null;
    } catch {
      return null;
    }
  },
  write(t: EntityTarget, liked: boolean): void {
    try {
      globalThis.localStorage?.setItem(likedHint.key(t), liked ? "1" : "0");
    } catch {
      /* storage unavailable: nothing remembered */
    }
  },
};

/** Put a new comment where the list shows it: a reply under its parent, a top-level one after the pinned ones. */
export function insertComment(threads: ClientThread[], comment: ClientComment): ClientThread[] {
  if (comment.parentId) {
    return threads.map((t) => (t.id === comment.parentId ? { ...t, replies: [...t.replies, comment] } : t));
  }
  return [...threads, { ...comment, replies: [] }];
}

/**
 * Add a page of threads from the server to those already shown: no thread twice (the one already shown wins, it may
 * have been edited here), in the server's order (pinned first, then oldest first). Needed because a comment posted
 * here is shown at once, before the pages that sort ahead of it have been loaded.
 */
export function mergeThreads(shown: ClientThread[], incoming: ClientThread[]): ClientThread[] {
  const seen = new Set(shown.map((t) => t.id));
  const merged = [...shown, ...incoming.filter((t) => !seen.has(t.id))];
  return merged.sort(
    (a, b) =>
      Number(b.isPinned) - Number(a.isPinned) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function replaceComment(threads: ClientThread[], comment: ClientComment): ClientThread[] {
  return threads.map((t) =>
    t.id === comment.id
      ? { ...t, ...comment, replies: t.replies }
      : { ...t, replies: t.replies.map((r) => (r.id === comment.id ? comment : r)) },
  );
}

/** Remove a comment (and, for a top-level one, its replies). Returns the list and how many visible rows left it. */
export function removeComment(threads: ClientThread[], id: string): { threads: ClientThread[]; removed: number } {
  const top = threads.find((t) => t.id === id);
  if (top) return { threads: threads.filter((t) => t.id !== id), removed: 1 + top.replies.length };
  let removed = 0;
  const next = threads.map((t) => {
    const replies = t.replies.filter((r) => r.id !== id);
    removed += t.replies.length - replies.length;
    return replies.length === t.replies.length ? t : { ...t, replies };
  });
  return { threads: next, removed };
}
