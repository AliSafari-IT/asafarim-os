/**
 * Media cleanup on a timer (#359): once an hour, in the server process, when the media store is configured. One
 * instance runs it at a time (cleanupMedia takes an advisory lock). A failed run is logged and the next one tries
 * again; nothing depends on it running on time.
 */
import { db } from "../db";
import { cleanupMedia } from "./assets";
import { getMediaStore } from "./store";

export const CLEANUP_EVERY_MS = 3600_000;

export function scheduleMediaCleanup(): void {
  const store = getMediaStore();
  if (!store) return;
  const run = async () => {
    try {
      const removed = await cleanupMedia(await db(), store);
      if (removed) console.info(JSON.stringify({ app: "knowledge", msg: "media.cleanup", removed }));
    } catch (err) {
      console.warn(
        JSON.stringify({
          app: "knowledge",
          msg: "media.cleanup_failed",
          error: err instanceof Error ? err.name : "error",
        }),
      );
    }
  };
  setInterval(run, CLEANUP_EVERY_MS).unref();
}
