import { describe, expect, it } from "vitest";
import { deckOrder, knownCount, knownKey, parseKnown, withKnown } from "../lib/study-cards";

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
