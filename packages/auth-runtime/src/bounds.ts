import { InvalidConfigError } from "./errors.js";
import type { ResolvedBounds, SessionBounds } from "./types.js";

/**
 * An example that matches identity's own session (12 h absolute, 30 min idle, 5 min fresh, 60 s provider re-check). It is
 * a constant to copy from, NOT applied implicitly: `createSessionRuntime` requires bounds, so every app states its own.
 */
export const defaultBounds: Readonly<SessionBounds> = Object.freeze({
  absoluteMs: 12 * 3600_000,
  idleMs: 30 * 60_000,
  freshMs: 5 * 60_000,
  revalidateMs: 60_000,
});

/**
 * The shortest step-up window the runtime accepts. core/identity answers `prompt=login` from its own session when that
 * session is younger than 120 s (FRESH_LOGIN_SLACK_SECONDS in core/identity/src/provider.ts), so a shorter `freshMs` can
 * loop: the provider reuses a login the app already finds too old. core/identity/test/fresh-window.test.ts keeps the two equal.
 */
export const MIN_FRESH_MS = 120_000;

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Validate and fill in the optional numbers. Throws {@link InvalidConfigError} on nonsense (zero, negative, unordered). */
export function resolveBounds(b: SessionBounds | undefined): ResolvedBounds {
  if (!b) throw new InvalidConfigError("bounds are required (there are no implicit defaults)");
  const { absoluteMs, idleMs, freshMs, revalidateMs } = b;
  const refreshSkewMs = b.refreshSkewMs ?? 10_000;
  const refreshLeaseMs = b.refreshLeaseMs ?? 30_000;
  const logoutMarkerSlackMs = b.logoutMarkerSlackMs ?? 300_000;
  if (!positive(absoluteMs)) throw new InvalidConfigError("bounds.absoluteMs must be positive");
  if (idleMs !== null && !positive(idleMs)) throw new InvalidConfigError("bounds.idleMs must be positive or null");
  if (!positive(freshMs)) throw new InvalidConfigError("bounds.freshMs must be positive");
  if (freshMs < MIN_FRESH_MS)
    throw new InvalidConfigError("bounds.freshMs must be at least 120000 (identity reuses a login younger than 120 s)");
  if (!positive(revalidateMs)) throw new InvalidConfigError("bounds.revalidateMs must be positive");
  if (typeof refreshSkewMs !== "number" || !Number.isFinite(refreshSkewMs) || refreshSkewMs < 0)
    throw new InvalidConfigError("bounds.refreshSkewMs must not be negative");
  if (!positive(refreshLeaseMs)) throw new InvalidConfigError("bounds.refreshLeaseMs must be positive");
  if (!positive(logoutMarkerSlackMs)) throw new InvalidConfigError("bounds.logoutMarkerSlackMs must be positive");
  if (idleMs !== null && idleMs > absoluteMs) throw new InvalidConfigError("bounds.idleMs must not exceed absoluteMs");
  if (freshMs > absoluteMs) throw new InvalidConfigError("bounds.freshMs must not exceed absoluteMs");
  if (revalidateMs > absoluteMs) throw new InvalidConfigError("bounds.revalidateMs must not exceed absoluteMs");
  return { absoluteMs, idleMs, freshMs, revalidateMs, refreshSkewMs, refreshLeaseMs, logoutMarkerSlackMs };
}

const CLOCK_SKEW_MS = 5000;

/**
 * Is the person's last authentication recent enough? `authTime` is seconds from the verified ID token. A value that is not
 * a finite number, or lies in the future beyond a small skew, is never fresh.
 */
export function isFresh(authTime: unknown, nowMs: number, freshMs: number): boolean {
  if (typeof authTime !== "number" || !Number.isFinite(authTime) || authTime <= 0) return false;
  const ms = authTime * 1000;
  if (ms > nowMs + CLOCK_SKEW_MS) return false;
  return nowMs - ms <= freshMs;
}
