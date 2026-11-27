"use client";
/**
 * The comments of one entity: pinned first, then oldest first, with one level of replies. A guest reads them and is
 * offered a sign-in link; a signed-in person who may comment writes, replies, and edits or deletes their own; a
 * moderator may delete anyone's. Every write is checked again by the server, so these props only decide what the
 * page offers, never what is allowed. Deleting asks for confirmation inline (never `window.confirm`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createEngagementClient,
  EngagementApiError,
  insertComment,
  removeComment,
  replaceComment,
  type ClientComment,
  type ClientThread,
  type EngagementClient,
} from "./api.ts";

/** Kept in step with MAX_COMMENT_LENGTH in src/service.ts (the server enforces it). */
const MAX_LENGTH = 2000;
const PAGE = 50;

export interface CommentViewer {
  id: string;
  /** Holds the app's comment permission. A signed-in person without it reads only. */
  canComment: boolean;
  /** May delete other people's comments. */
  canModerate?: boolean;
}

export interface CommentSectionProps {
  entityType: string;
  entityId: string;
  /** The signed-in person, or null for a guest. */
  viewer: CommentViewer | null;
  /** Where a guest signs in (the app's sign-in URL, returning to this page). */
  signInHref?: string;
  /** Total visible comments the page already knows, for the heading before the list loads. */
  initialCount?: number;
  basePath?: string;
  heading?: string;
  client?: EngagementClient;
}

const ROLE_LABEL: Record<string, string> = { instructor: "Instructor", admin: "Admin", moderator: "Moderator" };

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof EngagementApiError) {
    if (err.status === 401) return "Your session has ended. Sign in again to continue.";
    if (err.status === 403) return "You may not do that.";
    if (err.status === 429) return "Too many requests. Wait a moment and try again.";
    if (err.status === 400 && err.message) return err.message;
    if (err.status === 0) return err.message;
  }
  return fallback;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function Composer({
  label,
  submitLabel,
  initial = "",
  onSubmit,
  onCancel,
  autoFocus,
}: {
  label: string;
  submitLabel: string;
  initial?: string;
  onSubmit(body: string): Promise<void>;
  onCancel?(): void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = [...body.trim()].length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || length === 0 || length > MAX_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body.trim());
      setBody("");
    } catch (err) {
      setError(messageOf(err, "Could not save your comment. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="engagement-composer" onSubmit={submit} data-testid="comment-form">
      <label>
        <span className="engagement-visually-hidden">{label}</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={label}
          rows={3}
          maxLength={MAX_LENGTH * 2}
          autoFocus={autoFocus}
          aria-invalid={length > MAX_LENGTH}
          data-testid="comment-input"
        />
      </label>
      <div className="engagement-composer-row">
        <span className={length > MAX_LENGTH ? "engagement-counter engagement-over" : "engagement-counter"}>
          {length}/{MAX_LENGTH}
        </span>
        {onCancel ? (
          <button type="button" className="engagement-link" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          className="engagement-primary"
          disabled={busy || length === 0 || length > MAX_LENGTH}
          data-testid="comment-submit"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
      {error ? (
        <p role="alert" className="engagement-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function CommentItem({
  comment,
  viewer,
  onReply,
  onEdit,
  onDelete,
}: {
  comment: ClientComment;
  viewer: CommentViewer | null;
  onReply?: () => void;
  onEdit(body: string): Promise<void>;
  onDelete(): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = viewer?.id === comment.userId;
  const canDelete = mine || viewer?.canModerate === true;
  const role = comment.author.role ? (ROLE_LABEL[comment.author.role] ?? comment.author.role) : null;
  const edited = comment.updatedAt !== comment.createdAt;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(messageOf(err, "Could not delete the comment. Try again."));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <article className="engagement-comment" data-testid="comment" data-pinned={comment.isPinned ? "true" : undefined}>
      <header className="engagement-comment-head">
        {comment.author.avatarUrl ? (
          <img className="engagement-avatar" src={comment.author.avatarUrl} alt="" width={28} height={28} />
        ) : (
          <span className="engagement-avatar engagement-avatar-initial" aria-hidden="true">
            {comment.author.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <strong className="engagement-author">{comment.author.name}</strong>
        {role ? (
          <span className="engagement-role" data-testid="comment-role">
            {role}
          </span>
        ) : null}
        {comment.isPinned ? <span className="engagement-pin">Pinned</span> : null}
        <time className="engagement-time" dateTime={comment.createdAt}>
          {when(comment.createdAt)}
          {edited ? " · edited" : ""}
        </time>
      </header>
      {editing ? (
        <Composer
          label="Edit your comment"
          submitLabel="Save"
          initial={comment.body}
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await onEdit(body);
            setEditing(false);
          }}
        />
      ) : (
        <p className="engagement-body" data-testid="comment-body">
          {comment.body}
        </p>
      )}
      {!editing ? (
        <div className="engagement-actions">
          {onReply ? (
            <button type="button" className="engagement-link" onClick={onReply} data-testid="comment-reply">
              Reply
            </button>
          ) : null}
          {mine ? (
            <button type="button" className="engagement-link" onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
          {canDelete && !confirming ? (
            <button
              type="button"
              className="engagement-link"
              onClick={() => setConfirming(true)}
              data-testid="comment-delete"
            >
              Delete
            </button>
          ) : null}
          {confirming ? (
            <span className="engagement-confirm" role="group" aria-label="Confirm delete">
              <span>Delete this comment{comment.parentId ? "" : " and its replies"}?</span>
              <button
                type="button"
                className="engagement-danger"
                onClick={remove}
                disabled={busy}
                data-testid="comment-delete-confirm"
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
              <button type="button" className="engagement-link" onClick={() => setConfirming(false)} disabled={busy}>
                Keep
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="engagement-error">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function CommentSection({
  entityType,
  entityId,
  viewer,
  signInHref,
  initialCount = 0,
  basePath,
  heading = "Comments",
  client: given,
}: CommentSectionProps) {
  const client = useMemo(() => given ?? createEngagementClient({ basePath }), [given, basePath]);
  const target = useMemo(() => ({ entityType, entityId }), [entityType, entityId]);
  const [threads, setThreads] = useState<ClientThread[]>([]);
  const [total, setTotal] = useState(0);
  const [count, setCount] = useState(Math.max(0, initialCount));
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const page = await client.listComments(target, { limit: PAGE, offset: 0 });
      if (!alive.current) return;
      setThreads(page.comments);
      setTotal(page.total);
      setCount((n) =>
        Math.max(
          n,
          page.comments.reduce((s, t) => s + 1 + t.replies.length, 0),
        ),
      );
      setState("ready");
    } catch {
      if (alive.current) setState("error");
    }
  }, [client, target]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function more() {
    setLoadingMore(true);
    try {
      const page = await client.listComments(target, { limit: PAGE, offset: threads.length });
      if (!alive.current) return;
      const seen = new Set(threads.map((t) => t.id));
      setThreads((ts) => [...ts, ...page.comments.filter((t) => !seen.has(t.id))]);
      setTotal(page.total);
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }

  async function create(body: string, parentId: string | null) {
    const { comment } = await client.createComment(target, body, parentId);
    setThreads((ts) => insertComment(ts, comment));
    if (!parentId) setTotal((n) => n + 1);
    setCount((n) => n + 1);
    setReplyTo(null);
  }

  async function edit(id: string, body: string) {
    const { comment } = await client.editComment(id, body);
    setThreads((ts) => replaceComment(ts, comment));
  }

  async function remove(id: string, topLevel: boolean) {
    const { removed } = await client.deleteComment(id);
    setThreads((ts) => removeComment(ts, id).threads);
    if (topLevel) setTotal((n) => Math.max(0, n - 1));
    setCount((n) => Math.max(0, n - removed));
  }

  const canWrite = viewer?.canComment === true;

  return (
    <section className="engagement-comments" aria-labelledby={`engagement-h-${entityType}-${entityId}`}>
      <h2 id={`engagement-h-${entityType}-${entityId}`} data-testid="comments-heading">
        {heading} {count > 0 ? <span className="engagement-count">({count})</span> : null}
      </h2>

      {canWrite ? (
        <Composer label="Add a comment" submitLabel="Post comment" onSubmit={(body) => create(body, null)} />
      ) : viewer ? (
        <p className="engagement-note" data-testid="comment-no-permission">
          Your account can read comments but not write them yet.
        </p>
      ) : (
        <p className="engagement-note" data-testid="comment-sign-in">
          {signInHref ? <a href={signInHref}>Sign in</a> : "Sign in"} to join the conversation.
        </p>
      )}

      {state === "loading" ? (
        <p className="engagement-note" aria-live="polite">
          Loading comments…
        </p>
      ) : state === "error" ? (
        <p className="engagement-error" role="alert">
          Comments could not be loaded.{" "}
          <button type="button" className="engagement-link" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : threads.length === 0 ? (
        <p className="engagement-note" data-testid="comments-empty">
          No comments yet.{canWrite ? " Be the first." : ""}
        </p>
      ) : (
        <ol className="engagement-thread-list">
          {threads.map((t) => (
            <li key={t.id}>
              <CommentItem
                comment={t}
                viewer={viewer}
                onReply={canWrite ? () => setReplyTo(replyTo === t.id ? null : t.id) : undefined}
                onEdit={(body) => edit(t.id, body)}
                onDelete={() => remove(t.id, true)}
              />
              {t.replies.length > 0 || replyTo === t.id ? (
                <ol className="engagement-replies">
                  {t.replies.map((r) => (
                    <li key={r.id}>
                      <CommentItem
                        comment={r}
                        viewer={viewer}
                        onEdit={(body) => edit(r.id, body)}
                        onDelete={() => remove(r.id, false)}
                      />
                    </li>
                  ))}
                  {replyTo === t.id ? (
                    <li>
                      <Composer
                        label={`Reply to ${t.author.name}`}
                        submitLabel="Reply"
                        autoFocus
                        onCancel={() => setReplyTo(null)}
                        onSubmit={(body) => create(body, t.id)}
                      />
                    </li>
                  ) : null}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {state === "ready" && threads.length < total ? (
        <button type="button" className="engagement-link" onClick={() => void more()} disabled={loadingMore}>
          {loadingMore ? "Loading…" : `Show more comments (${total - threads.length})`}
        </button>
      ) : null}
    </section>
  );
}
