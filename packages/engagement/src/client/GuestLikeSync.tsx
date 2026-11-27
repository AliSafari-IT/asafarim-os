"use client";
/**
 * Render on pages a signed-in person sees: once per signed-in person and browser, it asks the server to move the
 * likes this browser made as a guest to the account (POST /likes/sync). It sends nothing when this browser never
 * liked anything, and nothing again once a sync went through. Invisible; failures are silent (the guest likes stay
 * guest likes, counted once either way).
 */
import { useEffect, useMemo } from "react";
import { createEngagementClient, likedHint, type EngagementClient } from "./api.ts";

export interface GuestLikeSyncProps {
  /** The signed-in person's id: a sync is remembered per person, so switching accounts syncs again. */
  userId: string;
  basePath?: string;
  client?: EngagementClient;
}

export const SYNC_DONE_KEY = "asafarim.engagement.synced:";

export function GuestLikeSync({ userId, basePath, client: given }: GuestLikeSyncProps) {
  const client = useMemo(() => given ?? createEngagementClient({ basePath }), [given, basePath]);
  useEffect(() => {
    const done = `${SYNC_DONE_KEY}${userId}`;
    try {
      if (globalThis.localStorage?.getItem(done) === "1") return;
    } catch {
      return; // no storage: we can't remember having synced, so don't keep asking
    }
    if (!likedHint.any()) return;
    let cancelled = false;
    client.syncLikes().then(
      () => {
        if (cancelled) return;
        try {
          globalThis.localStorage?.setItem(done, "1");
        } catch {
          /* nothing remembered: the next page asks again, which is harmless */
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, userId]);
  return null;
}
