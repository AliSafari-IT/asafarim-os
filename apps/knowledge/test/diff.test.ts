import { describe, expect, it } from "vitest";
import { DIFF_CELL_LIMIT, diffLines, diffStats } from "../lib/diff";

const render = (before: string, after: string) =>
  diffLines(before, after).map((l) => `${l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}${l.text}`);

describe("the revision comparison's line diff", () => {
  it("keeps, removes and adds lines in order", () => {
    expect(render("a\nb\nc\nd", "a\nc\nd\ne")).toEqual([" a", "-b", " c", " d", "+e"]);
    expect(render("a\nb", "a\nx\nb")).toEqual([" a", "+x", " b"]);
    expect(render("one\ntwo", "uno\ntwo")).toEqual(["-one", "+uno", " two"]);
  });

  it("handles empty sides and identical texts", () => {
    expect(render("", "")).toEqual([]);
    expect(render("", "a\nb")).toEqual(["+a", "+b"]);
    expect(render("a", "")).toEqual(["-a"]);
    expect(render("same\ntext", "same\ntext")).toEqual([" same", " text"]);
  });

  it("falls back to a plain replacement past the size bound, keeping the common start and end", () => {
    const n = Math.ceil(Math.sqrt(DIFF_CELL_LIMIT)) + 10;
    const before = ["top", ...Array.from({ length: n }, (_, i) => `old ${i}`), "bottom"].join("\n");
    const after = ["top", ...Array.from({ length: n }, (_, i) => `new ${i}`), "bottom"].join("\n");
    const lines = diffLines(before, after);
    expect(lines[0]).toEqual({ kind: "same", text: "top" });
    expect(lines.at(-1)).toEqual({ kind: "same", text: "bottom" });
    expect(diffStats(lines)).toEqual({ added: n, removed: n });
  });
});
