import { InvalidConfigError, InvalidReturnTargetError } from "./errors.js";

export interface ReturnTargetOptions {
  /** The app's own origin, exactly (`https://app.example`). Relative targets resolve against it. */
  origin: string;
  /** Further origins a target may point to, exactly. Empty by default: no open redirect. */
  allowedOrigins?: readonly string[];
  maxLength?: number;
}

/** C0/C1 control characters and the Unicode line separators: never valid in a redirect target. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

export function normalizeOrigin(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new InvalidConfigError("origin must be an absolute URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new InvalidConfigError("origin must be https (http only for localhost)");
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
    throw new InvalidConfigError("origin must be a bare origin");
  return u.origin;
}

/**
 * A return target the app may redirect to after sign-in. Accepts a same-origin relative path (`/x?y#z`, a single leading
 * slash) or an absolute URL whose origin is one of the configured origins exactly. Everything else throws
 * {@link InvalidReturnTargetError}: `//host`, backslashes, schemes, control characters, credentials, overlong values.
 * Returns the normalised target.
 */
export function validateReturnTarget(target: unknown, opts: ReturnTargetOptions): string {
  const max = opts.maxLength ?? 512;
  if (typeof target !== "string" || target.length === 0 || target.length > max) throw new InvalidReturnTargetError();
  if (hasControl(target) || target.includes("\\")) throw new InvalidReturnTargetError();
  const origins = new Set([opts.origin, ...(opts.allowedOrigins ?? [])]);

  if (target.startsWith("/")) {
    if (target.startsWith("//")) throw new InvalidReturnTargetError();
    let u: URL;
    try {
      u = new URL(target, opts.origin);
    } catch {
      throw new InvalidReturnTargetError();
    }
    if (u.origin !== opts.origin) throw new InvalidReturnTargetError();
    return `${u.pathname}${u.search}${u.hash}`;
  }

  let u: URL;
  try {
    u = new URL(target);
  } catch {
    throw new InvalidReturnTargetError();
  }
  if (u.username || u.password) throw new InvalidReturnTargetError();
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new InvalidReturnTargetError();
  if (!origins.has(u.origin)) throw new InvalidReturnTargetError();
  return u.href;
}

/** {@link validateReturnTarget}, with `fallback` for anything not allowed (never throws). */
export function safeReturnTarget(target: unknown, opts: ReturnTargetOptions, fallback = "/"): string {
  try {
    return validateReturnTarget(target, opts);
  } catch {
    return fallback;
  }
}
