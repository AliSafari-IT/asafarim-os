/**
 * Who is a guest? The gateway (Caddy) APPENDS the real client address as the LAST `X-Forwarded-For` entry; every
 * entry to its left was sent by the client and can be forged, so only the last one counts (the same rule as
 * apps/knowledge `clientKey`). The visitor hash is a keyed HMAC-SHA-256 of that address and the User-Agent, with a
 * per-app secret (`ENGAGEMENT_SALT`), so the stored hash can neither be reversed to an address nor be matched across apps.
 */
import { createHmac } from "node:crypto";

export interface HeadersLike {
  get(name: string): string | null;
}

/** Shortest salt accepted: a short or missing salt makes the hash guessable, so the app must not start without one. */
export const MIN_SALT_LENGTH = 16;

const MAX_USER_AGENT = 512;

/** The client address the gateway reported, or X-Real-IP, or one shared "unknown" bucket. */
export function clientAddress(headers: HeadersLike): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

/** 64 lower-case hex characters. Throws when `salt` is missing or shorter than MIN_SALT_LENGTH (fail closed). */
export function visitorHash(input: { ip: string; userAgent: string | null | undefined; salt: string }): string {
  if (typeof input.salt !== "string" || input.salt.length < MIN_SALT_LENGTH) {
    throw new Error(`ENGAGEMENT_SALT must be set to at least ${MIN_SALT_LENGTH} characters`);
  }
  const userAgent = (input.userAgent ?? "").trim().slice(0, MAX_USER_AGENT);
  return createHmac("sha256", input.salt).update(`${input.ip}\n${userAgent}`).digest("hex");
}

/** The visitor hash of a request's headers. */
export function visitorHashOf(headers: HeadersLike, salt: string): string {
  return visitorHash({ ip: clientAddress(headers), userAgent: headers.get("user-agent"), salt });
}
