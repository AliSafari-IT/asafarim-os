import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, parseBefore } from "../lib/cursor";

describe("pagination cursors", () => {
  it("round-trip a PostgreSQL timestamp and an id", () => {
    const c = { at: "2026-11-18 22:20:13.123456+00", id: "0b7b6f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("reject anything else as no cursor", () => {
    const id = "0b7b6f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    for (const raw of [
      undefined,
      3,
      "",
      "!!!",
      encodeCursor({ at: "yesterday", id }),
      encodeCursor({ at: "2026-11-18 22:20:13+00", id: "1; DROP" }),
      "x".repeat(300),
    ]) {
      expect(decodeCursor(raw)).toBeNull();
    }
  });

  it("accept only a positive revision number for older revision pages", () => {
    expect(parseBefore("22")).toBe(22);
    for (const raw of [undefined, "", "0", "-1", "1.5", "abc", "1e3", "9999999999"])
      expect(parseBefore(raw)).toBeNull();
  });
});
