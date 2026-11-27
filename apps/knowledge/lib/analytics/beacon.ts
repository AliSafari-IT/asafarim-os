/**
 * The browser side of counting a share click: one small POST to this site, sent as the person leaves for the share
 * page. Client-safe (no server imports). Nothing is stored in the browser, and nothing is sent when the browser says
 * Global Privacy Control or Do Not Track.
 */
import type { ShareTarget } from "./classify";

export const EVENT_ENDPOINT = "/api/public/analytics/event";

export function trackShare(slug: string, target: ShareTarget): void {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.globalPrivacyControl || nav.doNotTrack === "1") return;
    const body = JSON.stringify({ type: "share", slug, target });
    // sendBeacon survives the page being left; the fetch fallback asks for the same ("keepalive").
    if (
      typeof nav.sendBeacon === "function" &&
      nav.sendBeacon(EVENT_ENDPOINT, new Blob([body], { type: "application/json" }))
    )
      return;
    void fetch(EVENT_ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "content-type": "application/json" },
    }).catch(() => undefined);
  } catch {
    // Counting is never worth an error in the page.
  }
}
