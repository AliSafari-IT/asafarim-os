/**
 * Counting a page view from inside a server component. The page calls this once it knows the page exists (so a 404 is
 * never counted); everything else (is this a real person, where from, which label) is decided by the rules in
 * classify.ts. It can never break a page: a failure is logged and the page renders as if nothing happened.
 */
import { headers } from "next/headers";
import { db } from "../db";
import { publicOrigin } from "../site";
import { cleanSearchTerm, refererSource, shouldCountView } from "./classify";
import { purgeOldAnalytics, recordEvent } from "./store";

const hostOnly = (h: string) => h.split(",")[0]!.trim().replace(/:\d+$/, "");

export async function recordPageView(key: string, searchTerm?: unknown): Promise<void> {
  try {
    const h = await headers();
    if (!shouldCountView(h)) return;
    const own = [new URL(publicOrigin()).hostname, h.get("host"), h.get("x-forwarded-host")]
      .filter((v): v is string => Boolean(v))
      .map(hostOnly);
    const pool = await db();
    await recordEvent(pool, "view", key, refererSource(h.get("referer"), own));
    const term = searchTerm === undefined ? null : cleanSearchTerm(searchTerm);
    if (term) await recordEvent(pool, "search", term, "");
    // Old rows go now and then, on a small fraction of views: no scheduler to run, and a cheap delete by date.
    if (Math.random() < 1 / 2000) void purgeOldAnalytics(pool).catch(() => undefined);
  } catch (err) {
    console.warn(
      JSON.stringify({
        app: "knowledge",
        level: "warn",
        msg: "analytics.record_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
