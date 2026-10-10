/** Pure helpers for the Status page (P6.1; unit-tested in test/status.test.ts). */
import type { AppStatus } from "./core-api";

/** Text for a probe, so the badge never relies on color alone. */
export const PROBE_LABEL: Record<AppStatus["live"], string> = { up: "Up", down: "Down", unknown: "Unknown" };

/** What core-api's error classes mean, in a sentence. */
const ERROR_TEXT: Record<string, string> = {
  timeout: "No answer within the timeout",
  refused: "Connection refused: nothing is listening",
  bad_status: "Answered with an error status",
  unreachable: "Couldn't reach it",
  no_upstream: "core-api doesn't know where it runs",
  bad_path: "Its manifest's health path isn't usable",
  check_failed: "A check failed",
};

/** The problem column: the error class explained, plus its detail (status, env var, failed checks). */
export function problemText(s: Pick<AppStatus, "error" | "detail">): string | undefined {
  if (!s.error) return undefined;
  const text = ERROR_TEXT[s.error] ?? s.error;
  if (!s.detail) return text;
  if (s.error === "bad_status") return `${text} (HTTP ${s.detail})`;
  if (s.error === "no_upstream") return `${text} (set ${s.detail})`;
  return `${text}: ${s.detail}`;
}

export type Overall = "up" | "degraded" | "down" | "unknown";

/** One word for an app: up (both up), down (live down), degraded (live up, ready not), unknown otherwise. */
export function overall(s: Pick<AppStatus, "polled" | "live" | "ready">): Overall {
  if (!s.polled || s.live === "unknown") return "unknown";
  if (s.live === "down") return "down";
  return s.ready === "up" ? "up" : "degraded";
}

/** "2 of 3 polled services are up" plus the not-polled count. */
export function summary(apps: AppStatus[]): { polled: number; up: number; notPolled: number } {
  const polled = apps.filter((a) => a.polled);
  return {
    polled: polled.length,
    up: polled.filter((a) => overall(a) === "up").length,
    notPolled: apps.length - polled.length,
  };
}

/** "120 ms", or an en dash when there's no measurement. */
export const formatLatency = (ms: number | null): string => (ms === null ? "–" : `${ms} ms`);
