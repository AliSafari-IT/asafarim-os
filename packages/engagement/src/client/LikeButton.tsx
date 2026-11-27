"use client";
/**
 * A like toggle for one entity. Anyone may like (guests too: the server tells them apart by a keyed visitor hash),
 * so it never asks anyone to sign in. The guest's last choice is remembered in localStorage only as a hint shown
 * before the server answers; the server's answer always wins. Clicks are optimistic and rolled back on failure.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  compactCount,
  createEngagementClient,
  likedHint,
  EngagementApiError,
  type EngagementClient,
  type LikeState,
} from "./api.ts";

export interface LikeButtonProps {
  entityType: string;
  entityId: string;
  /** The count the page already knows (server-rendered), shown until the server's own answer arrives. */
  initialCount?: number;
  basePath?: string;
  /** Visible label next to the heart (default "Like"); the button's accessible name says liked or not. */
  label?: string;
  className?: string;
  /** For tests and custom transports. */
  client?: EngagementClient;
}

export function LikeButton({
  entityType,
  entityId,
  initialCount = 0,
  basePath,
  label = "Like",
  className,
  client: given,
}: LikeButtonProps) {
  const client = useMemo(() => given ?? createEngagementClient({ basePath }), [given, basePath]);
  const target = useMemo(() => ({ entityType, entityId }), [entityType, entityId]);
  const [state, setState] = useState<LikeState>({ liked: false, count: Math.max(0, initialCount) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const hint = likedHint.read(target);
    if (hint !== null) setState((s) => ({ ...s, liked: hint }));
    client.likeState(target).then(
      (fresh) => {
        if (!alive.current) return;
        setState(fresh);
        likedHint.write(target, fresh.liked);
      },
      () => undefined, // keep the server-rendered count; a click will try again
    );
    return () => {
      alive.current = false;
    };
  }, [client, target]);

  async function toggle() {
    if (busy) return;
    const before = state;
    setBusy(true);
    setMessage(null);
    setState({ liked: !before.liked, count: Math.max(0, before.count + (before.liked ? -1 : 1)) });
    try {
      const after = await client.toggleLike(target);
      if (!alive.current) return;
      setState(after);
      likedHint.write(target, after.liked);
    } catch (err) {
      if (!alive.current) return;
      setState(before);
      setMessage(
        err instanceof EngagementApiError && err.status === 429
          ? `Too many clicks. Try again in ${err.retryAfter ?? 60} s.`
          : "Could not save your like. Try again.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <span className={className ? `engagement-like ${className}` : "engagement-like"}>
      <button
        type="button"
        className="engagement-like-button"
        aria-pressed={state.liked}
        aria-label={`${state.liked ? "Unlike" : label} (${state.count} ${state.count === 1 ? "like" : "likes"})`}
        data-testid="like-button"
        data-liked={state.liked ? "true" : "false"}
        disabled={busy}
        onClick={toggle}
      >
        <span aria-hidden="true" className="engagement-like-heart">
          {state.liked ? "♥" : "♡"}
        </span>
        <span aria-hidden="true">{label}</span>
        <span aria-hidden="true" className="engagement-like-count" data-testid="like-count">
          {compactCount(state.count)}
        </span>
      </button>
      {message ? (
        <span role="status" className="engagement-error">
          {message}
        </span>
      ) : null}
    </span>
  );
}
