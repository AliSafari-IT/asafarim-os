import { describe, expect, it } from "vitest";
import {
  dayOf,
  deckOrder,
  knownCount,
  knownKey,
  parseDays,
  parseKnown,
  streakOf,
  withDay,
  withKnown,
} from "../lib/study-cards";

describe("study cards in the browser", () => {
  it("keys marks by course id and reads anything unexpected as no marks", () => {
    expect(knownKey("c1")).toBe("knowledge.study-cards.c1");
    expect(parseKnown(null)).toEqual([]);
    expect(parseKnown("not json")).toEqual([]);
    expect(parseKnown('{"a":1}')).toEqual([]);
    expect(parseKnown('["a", 2, "b", "a"]')).toEqual(["a", "b"]);
  });

  it("marks a card known or still learning, without duplicates", () => {
    expect(withKnown(["a"], "b", true)).toEqual(["a", "b"]);
    expect(withKnown(["a", "b"], "a", true)).toEqual(["b", "a"]);
    expect(withKnown(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("goes through all cards or only the ones to learn, in order or shuffled", () => {
    const ids = ["a", "b", "c", "d"];
    const known = new Set(["b", "gone"]);
    expect(deckOrder(ids, { mode: "all", known, shuffle: false })).toEqual(ids);
    expect(deckOrder(ids, { mode: "review", known, shuffle: false })).toEqual(["a", "c", "d"]);
    // A fixed "random" that always picks the first remaining slot: a deterministic rotation.
    const shuffled = deckOrder(ids, { mode: "all", known, shuffle: true, random: () => 0 });
    expect(shuffled).toEqual(["b", "c", "d", "a"]);
    expect([...shuffled].sort()).toEqual(ids);
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(knownCount(ids, known)).toBe(1);
  });
});

describe("study streak", () => {
  it("counts days in a row ending today, or yesterday when today has no study yet", () => {
    expect(dayOf(new Date(2026, 0, 5))).toBe("2026-01-05");
    const days = withDay(withDay(withDay([], "2026-02-28"), "2026-03-01"), "2026-02-27");
    expect(days).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(withDay(days, "2026-03-01")).toEqual(days);
    expect(streakOf(days, "2026-03-01")).toBe(3);
    expect(streakOf(days, "2026-03-02")).toBe(3);
    expect(streakOf(days, "2026-03-03")).toBe(0);
    expect(streakOf([], "2026-03-03")).toBe(0);
    expect(parseDays('["2026-01-02", "bad", 3, "2026-01-01"]')).toEqual(["2026-01-01", "2026-01-02"]);
    expect(parseDays("{")).toEqual([]);
  });
});
