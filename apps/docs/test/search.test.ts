import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetSearchIndex, searchIndex } from "../lib/search";
import { createFixtureBackend, createSource, createUnavailableBackend, SourceUnavailableError } from "../lib/source";

const fixtures = () => createSource(createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures")));

describe("the search index (#80)", () => {
  beforeEach(resetSearchIndex);

  it("has every document's title, folders and headings, and none of the body", async () => {
    const index = await searchIndex(fixtures());
    expect(index.map((d) => d.path)).toContain("ventures/demo-app/roadmap/roadmap.md");
    expect(index.find((d) => d.path === "ventures/demo-app/roadmap/roadmap.md")).toEqual({
      path: "ventures/demo-app/roadmap/roadmap.md",
      title: "Demo app roadmap",
      crumbs: ["Ventures", "Demo App", "Roadmap"],
      headings: [
        { text: "Milestones", id: "milestones" },
        { text: "Timeline", id: "timeline" },
        { text: "Architecture", id: "architecture" },
        { text: "Setup", id: "setup" },
        { text: "Tracking", id: "tracking" },
      ],
    });
    expect(JSON.stringify(index)).not.toContain("docs-fixture-marker");
  });

  it("is built once per listing", async () => {
    const source = fixtures();
    expect(await searchIndex(source)).toBe(await searchIndex(source));
  });

  it("an unreachable source fails the search", async () => {
    await expect(searchIndex(createSource(createUnavailableBackend("down")))).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });
});
