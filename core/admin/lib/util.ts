/** Small pure helpers for the console (unit-tested in test/util.test.ts). */

/** The `exp` (seconds) of a JWT, read WITHOUT verifying it (core-api verifies it): used only to avoid sending an expired one. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** True when the token has no readable expiry or expires within `skewSeconds`. */
export function idTokenExpired(token: string, nowMs = Date.now(), skewSeconds = 10): boolean {
  const exp = jwtExpiry(token);
  return exp === undefined || exp * 1000 <= nowMs + skewSeconds * 1000;
}

/** A path inside the console only (`/admin…`), so a form field can't redirect elsewhere. */
export function safeAdminPath(raw: unknown, fallback = "/admin/apps"): string {
  if (typeof raw !== "string" || raw.length > 512) return fallback;
  return /^\/admin(?:\/[A-Za-z0-9_\-./]*)?(?:\?[A-Za-z0-9_\-.=&%:@]*)?$/.test(raw) && !raw.includes("..")
    ? raw
    : fallback;
}

/** `path` with a one-line message for the next page to show (`notice` or `error`). */
export function withMessage(path: string, kind: "notice" | "error", message: string): string {
  const url = new URL(path, "http://console.invalid");
  url.searchParams.delete("notice");
  url.searchParams.delete("error");
  url.searchParams.set(kind, message.slice(0, 300));
  return `${url.pathname}${url.search}`;
}

/** 2026-10-04 19:31:07 UTC */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** An app id or role key as the API accepts it. */
export const isAppId = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{1,31}$/.test(v);
export const isRoleKey = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(v);
export const isSubject = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:@-]{1,128}$/.test(v);

/** A removal is confirmed only by typing the app id exactly (the dialog checks it, and so does the action). */
export const confirmsRemoval = (app: string, typed: unknown): boolean => typeof typed === "string" && typed === app;
