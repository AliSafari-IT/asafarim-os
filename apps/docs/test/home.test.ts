import { describe, expect, it } from "vitest";
import { docsInOrder, homeOf, neighboursOf, SECTION_PREVIEW } from "../lib/home";
import { readableName } from "../lib/outline";
import { buildTree } from "../lib/reader";
import type { DocEntry } from "../lib/source";

const doc = (path: string): DocEntry => ({ path, kind: "doc" });
/** What a link to `path` looks like: the sidebar's readable file name. */
const link = (path: string) => ({ label: readableName(path.split("/").at(-1)!), path });
/** The same, in a folder below the section: the folder is named too. */
const inFolder = (path: string) => ({ ...link(path), where: readableName(path.split("/").at(-2)!) });

// The fixtures' shape, plus a bigger section and an image (never a document).
const tree = buildTree([
  doc("index.md"),
  doc("README.md"),
  doc("guides/getting-started.md"),
  { path: "images/diagram.svg", kind: "image" },
  doc("ventures/demo-app/overview.md"),
  doc("ventures/demo-app/roadmap/roadmap.md"),
  doc("ventures/demo-app/decisions/0001-use-postgres.md"),
  doc("ventures/other-app/overview.md"),
  doc("ventures/other-app/plan.md"),
]);

describe("the home page", () => {
  it("starts at index.md, with one card per top-level folder that holds documents, in sidebar order", () => {
    const home = homeOf(tree);
    expect(home.start).toEqual(link("index.md"));
    expect(home.sections.map((s) => [s.label, s.count])).toEqual([
      [readableName("guides"), 1],
      [readableName("ventures"), 5],
    ]);
    // An images-only folder gets no card.
    expect(home.sections.some((s) => s.label === readableName("images"))).toBe(false);
    // The other root documents are listed apart; the start document isn't repeated.
    expect(home.loose).toEqual([{ label: "README", path: "README.md" }]);
  });

  it(`lists the first ${SECTION_PREVIEW} documents of a section and counts the rest`, () => {
    const ventures = homeOf(tree).sections[1]!;
    expect(ventures.docs).toHaveLength(SECTION_PREVIEW);
    expect(ventures.more).toBe(5 - SECTION_PREVIEW);
    expect(ventures.docs[0]).toEqual(inFolder("ventures/demo-app/decisions/0001-use-postgres.md"));
    // Two documents with the same name are told apart by their folder.
    expect(ventures.docs.slice(2).map((d) => d.where)).toEqual([readableName("demo-app"), readableName("other-app")]);
    // A document directly in its section's folder needs no folder name.
    expect(homeOf(tree).sections[0]!.docs[0]).toEqual(link("guides/getting-started.md"));
    expect(homeOf(tree).sections[0]!.more).toBe(0);
  });

  it("falls back to README.md, and to no start document at all", () => {
    expect(homeOf(buildTree([doc("README.md"), doc("a/b.md")])).start).toEqual({ label: "README", path: "README.md" });
    const none = homeOf(buildTree([doc("notes.md"), doc("a/b.md")]));
    expect(none.start).toBeUndefined();
    expect(none.loose).toEqual([link("notes.md")]);
  });

  it("is empty for an empty repository", () => {
    expect(homeOf([])).toEqual({ sections: [], loose: [] });
  });
});

describe("previous and next", () => {
  it("follow the sidebar's order: folders first, then files, depth first", () => {
    expect(docsInOrder(tree).map((d) => d.path)).toEqual([
      "guides/getting-started.md",
      "ventures/demo-app/decisions/0001-use-postgres.md",
      "ventures/demo-app/roadmap/roadmap.md",
      "ventures/demo-app/overview.md",
      "ventures/other-app/overview.md",
      "ventures/other-app/plan.md",
      "index.md",
      "README.md",
    ]);
  });

  it("link to the neighbours, with nothing past either end or for an unknown path", () => {
    expect(neighboursOf(tree, "ventures/demo-app/roadmap/roadmap.md")).toEqual({
      prev: inFolder("ventures/demo-app/decisions/0001-use-postgres.md"),
      next: inFolder("ventures/demo-app/overview.md"),
    });
    expect(neighboursOf(tree, "guides/getting-started.md").prev).toBeUndefined();
    expect(neighboursOf(tree, "README.md").next).toBeUndefined();
    expect(neighboursOf(tree, "nope.md")).toEqual({});
  });
});
