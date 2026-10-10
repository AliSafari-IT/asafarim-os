import { describe, expect, it } from "vitest";
import {
  confirmsRemoval,
  formatTime,
  idTokenExpired,
  isAppId,
  isRoleKey,
  isSubject,
  jwtExpiry,
  safeAdminPath,
  withMessage,
} from "../lib/util";

const jwt = (payload: object) =>
  `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("reading a token's expiry (never trusting it: core-api verifies)", () => {
  it("reads exp, and nothing from garbage", () => {
    expect(jwtExpiry(jwt({ exp: 1791150000 }))).toBe(1791150000);
    for (const bad of ["", "abc", "a.b.c", "a..c", jwt({}), jwt({ exp: "soon" })])
      expect(jwtExpiry(bad), bad).toBeUndefined();
  });

  it("is expired when past, within the skew, or unreadable; not before", () => {
    const now = Date.UTC(2026, 9, 4, 12, 0, 0);
    const at = (s: number) => jwt({ exp: Math.floor(now / 1000) + s });
    expect(idTokenExpired(at(3600), now)).toBe(false);
    expect(idTokenExpired(at(11), now)).toBe(false);
    expect(idTokenExpired(at(9), now)).toBe(true); // inside the 10 s skew: don't send a token about to die
    expect(idTokenExpired(at(-1), now)).toBe(true);
    expect(idTokenExpired("garbage", now)).toBe(true);
  });
});

describe("safeAdminPath (a form field can't redirect elsewhere)", () => {
  it("keeps console paths with a query", () => {
    expect(safeAdminPath("/admin/apps")).toBe("/admin/apps");
    expect(safeAdminPath("/admin/roles?app=notes&q=dev%20m")).toBe("/admin/roles?app=notes&q=dev%20m");
    expect(safeAdminPath("/admin")).toBe("/admin");
  });

  it("falls back for anything else", () => {
    for (const bad of [
      "//evil.example",
      "https://evil.example/admin",
      "/other",
      "/administrator",
      "/admin/../etc",
      "/admin/apps\r\nSet-Cookie: x=1",
      "/admin/\\evil",
      "/admin?x=<script>",
      "",
      null,
      undefined,
      42,
      `/admin/${"a".repeat(600)}`,
    ]) {
      expect(safeAdminPath(bad), String(bad)).toBe("/admin/apps");
    }
    expect(safeAdminPath("nope", "/admin/audit")).toBe("/admin/audit");
  });
});

describe("withMessage", () => {
  it("adds one message and replaces an earlier one, keeping the other parameters", () => {
    expect(withMessage("/admin/roles?app=notes", "notice", "Granted.")).toBe("/admin/roles?app=notes&notice=Granted.");
    expect(withMessage("/admin/apps?error=old", "notice", "Done")).toBe("/admin/apps?notice=Done");
    expect(withMessage("/admin/apps?notice=old", "error", "No")).toBe("/admin/apps?error=No");
  });

  it("encodes the message and caps its length", () => {
    expect(withMessage("/admin/apps", "error", "a&b=c")).toBe("/admin/apps?error=a%26b%3Dc");
    expect(withMessage("/admin/apps", "error", "x".repeat(1000)).length).toBeLessThan(330);
  });
});

describe("formatting and id checks", () => {
  it("formats a time as UTC, and leaves an unreadable one alone", () => {
    expect(formatTime("2026-10-04T19:31:07.123Z")).toBe("2026-10-04 19:31:07 UTC");
    expect(formatTime("not a date")).toBe("not a date");
  });

  it("accepts the ids the API accepts, and nothing else", () => {
    expect(isAppId("notes")).toBe(true);
    expect(isAppId("core")).toBe(true);
    for (const bad of ["", "Notes", "a", "x".repeat(40), "a b", 5, null]) expect(isAppId(bad), String(bad)).toBe(false);
    expect(isRoleKey("notes.editor")).toBe(true);
    for (const bad of ["notes", "Notes.Editor", "notes..x", "", "a.b c", null])
      expect(isRoleKey(bad), String(bad)).toBe(false);
    expect(isSubject("dev-member")).toBe(true);
    expect(isSubject("user@example.test:1")).toBe(true);
    for (const bad of ["", "a/b", "a b", "x".repeat(129), null]) expect(isSubject(bad), String(bad)).toBe(false);
  });
});

describe("confirming a removal (#68)", () => {
  it("only the exact app id confirms", () => {
    expect(confirmsRemoval("notes", "notes")).toBe(true);
    for (const typed of ["", "Notes", " notes", "notes ", "note", null, undefined, 1])
      expect(confirmsRemoval("notes", typed), String(typed)).toBe(false);
  });
});
