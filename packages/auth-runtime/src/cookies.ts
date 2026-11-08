import { InvalidConfigError } from "./errors.js";

/** Opaque ids are 32 random bytes, base64url (43 characters). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/**
 * The value of cookie `name`, or undefined when it is absent OR present more than once (an ambiguous header could be
 * an attacker's planted duplicate), or does not look like one of our ids.
 */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(eq + 1).trim();
  }
  return found !== undefined && ID_PATTERN.test(found) ? found : undefined;
}

export interface CookieOptions {
  maxAgeSec: number;
}

/** A host-only cookie: Secure, HttpOnly, SameSite=Lax, Path=/, and never a Domain attribute. */
export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  assertHostCookieName(name);
  if (!Number.isFinite(o.maxAgeSec)) throw new InvalidConfigError("cookie max age");
  if (value !== "" && !ID_PATTERN.test(value)) throw new InvalidConfigError("cookie value");
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(o.maxAgeSec))}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAgeSec: 0 });
}

export function assertHostCookieName(name: string): void {
  if (!/^__Host-[A-Za-z0-9._-]+$/.test(name)) throw new InvalidConfigError("cookie names must start with __Host-");
}
