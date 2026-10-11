import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { anchorNote, findQuote, sectionsOf, squash } from "../lib/anchor";
import { headingsOf } from "../lib/outline";

const roadmap = readFileSync(
  path.resolve(import.meta.dirname, "../fixtures/ventures/demo-app/roadmap/roadmap.md"),
  "utf8",
);

describe("a document's sections (#81)", () => {
  it("splits at the headings, with the ids the page gives them, under the title", () => {
    const sections = sectionsOf(roadmap);
    expect(sections.map((s) => s.id)).toEqual(["", "milestones", "timeline", "architecture", "setup", "tracking"]);
    expect(sections.slice(1).map((s) => s.id)).toEqual(headingsOf(roadmap).map((h) => h.id));
    expect(sections[0]!.text).toContain(squash("A made-up roadmap that shows everything"));
    expect(sections[0]!.text).not.toContain("Demoapproadmap");
  });

  it("holds the text a reader sees: table cells and code, no Mermaid source, image alt or raw HTML", () => {
    const [, milestones, timeline, architecture, setup] = sectionsOf(roadmap);
    expect(milestones!.text).toContain(squash("Beta Team B In progress"));
    expect(milestones!.text).toContain(squash("Ship the beta"));
    expect(timeline!.text).toBe("Timeline");
    expect(architecture!.text).toBe("Architecture");
    expect(setup!.text).toContain(squash("pnpm --filter demo-app dev"));
    // The tags are dropped, as on the page; the text between them stays.
    expect(sectionsOf("## A\n\n<b>raw</b> text")[1]!.text).toBe("Arawtext");
  });

  it("names repeated headings as rehype-slug does", () => {
    expect(sectionsOf("## Notes\n\none\n\n## Notes\n\ntwo").map((s) => s.id)).toEqual(["", "notes", "notes-1"]);
  });
});

describe("where a note shows (#81)", () => {
  const sections = sectionsOf(roadmap);

  it("under its heading when its quote is still there, whatever the whitespace", () => {
    expect(anchorNote({ headingId: "milestones", quote: "Ship   the\nbeta" }, sections)).toEqual({
      status: "ok",
      headingId: "milestones",
    });
  });

  it("follows its quote to another section when the text moved", () => {
    expect(anchorNote({ headingId: "timeline", quote: "Ship the beta" }, sections)).toEqual({
      status: "ok",
      headingId: "milestones",
    });
  });

  it("is kept under its heading, marked text changed, when the quote was edited away", () => {
    expect(anchorNote({ headingId: "setup", quote: "words nobody wrote" }, sections)).toEqual({
      status: "changed",
      headingId: "setup",
    });
  });

  it("goes to the top, text changed, when its heading is gone too", () => {
    expect(anchorNote({ headingId: "gone", quote: "words nobody wrote" }, sections)).toEqual({
      status: "changed",
      headingId: "",
    });
  });

  it("a note on a heading (no quote) is changed only when the heading is gone", () => {
    expect(anchorNote({ headingId: "setup", quote: "" }, sections).status).toBe("ok");
    expect(anchorNote({ headingId: "", quote: "" }, sections).status).toBe("ok");
    expect(anchorNote({ headingId: "gone", quote: "" }, sections)).toEqual({ status: "changed", headingId: "" });
  });
});

describe("finding a quote in the page's text (#81)", () => {
  const segments = ["Intro: ship it.", "Setup", "Run ", "pnpm install", " then ship it."];

  it("spans text nodes and ignores whitespace", () => {
    expect(findQuote(segments, "Run pnpminstall")).toEqual([
      { segment: 2, offset: 0 },
      { segment: 3, offset: 12 },
    ]);
  });

  it("takes the first match after the heading when the quote occurs more than once", () => {
    expect(findQuote(segments, "ship it", 1)).toEqual([
      { segment: 4, offset: 6 },
      { segment: 4, offset: 13 },
    ]);
    expect(findQuote(segments, "ship it", 0)![0]).toEqual({ segment: 0, offset: 7 });
  });

  it("falls back to anywhere, and finds nothing for text that isn't there", () => {
    expect(findQuote(segments, "Intro", 3)![0]).toEqual({ segment: 0, offset: 0 });
    expect(findQuote(segments, "nowhere")).toBeNull();
    expect(findQuote(segments, "   ")).toBeNull();
  });
});
