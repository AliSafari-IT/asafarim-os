import { describe, expect, it } from "vitest";
import type { AppStatus } from "../lib/core-api";
import { formatLatency, overall, problemText, summary } from "../lib/status";

const row = (over: Partial<AppStatus> & { id: string }): AppStatus => ({
  name: over.id,
  state: "active",
  polled: true,
  live: "up",
  ready: "up",
  latencyMs: 12,
  checkedAt: "2026-10-10T12:00:00.000Z",
  since: "2026-10-10T11:00:00.000Z",
  ...over,
});

describe("the Status page helpers (P6.1)", () => {
  it("one word per app: up, degraded (live but not ready), down, unknown (not polled)", () => {
    expect(overall(row({ id: "a" }))).toBe("up");
    expect(overall(row({ id: "a", ready: "down" }))).toBe("degraded");
    expect(overall(row({ id: "a", live: "down", ready: "down" }))).toBe("down");
    expect(overall(row({ id: "a", polled: false, live: "unknown", ready: "unknown" }))).toBe("unknown");
    expect(overall(row({ id: "a", live: "unknown", ready: "unknown" }))).toBe("unknown");
  });

  it("explains the error class with its detail", () => {
    expect(problemText({})).toBeUndefined();
    expect(problemText({ error: "bad_status", detail: "503" })).toBe("Answered with an error status (HTTP 503)");
    expect(problemText({ error: "no_upstream", detail: "OS_APP_NOTES_UPSTREAM" })).toMatch(/set OS_APP_NOTES_UPSTREAM/);
    expect(problemText({ error: "check_failed", detail: "database" })).toBe("A check failed: database");
    expect(problemText({ error: "timeout" })).toBe("No answer within the timeout");
    expect(problemText({ error: "something_new" })).toBe("something_new");
  });

  it("counts the polled services that are up and the ones not polled", () => {
    expect(
      summary([
        row({ id: "core-api" }),
        row({ id: "notes", ready: "down" }),
        row({ id: "docs", polled: false, state: "inactive", live: "unknown", ready: "unknown" }),
      ]),
    ).toEqual({ polled: 2, up: 1, notPolled: 1 });
  });

  it("formats latency", () => {
    expect(formatLatency(null)).toBe("–");
    expect(formatLatency(42)).toBe("42 ms");
  });
});
