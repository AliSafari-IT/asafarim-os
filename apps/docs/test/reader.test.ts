import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTree, docParam, loadReader, titleOf } from "../lib/reader";
import { createFixtureBackend, createSource, createUnavailableBackend } from "../lib/source";

const fixtures = () => createSource(createFixtureBackend(path.resolve(import.meta.dirname, "../fixtures")));
const SOURCE = "AliSafari-IT/asafarim-docs";

describe("the reading page's data (#78)", () => {
  it("shows the tree and the selected doc with the repo that owns it", async () => {
    const view = await loadReader(fixtures(), { doc: "ventures/demo-app/overview.md", sourceRepo: SOURCE });
    expect(view.status).toBe("ok");
    if (view.status !== "ok") return;
    expect(view.mode).toBe("fixtures");
    expect(view.docCount).toBe(6);
    expect(view.tree.map((n) => n.name)).toEqual(["guides", "images", "ventures", "index.md", "README.md"]);
    expect(view.doc).toMatchObject({
      title: "Demo app overview",
      owner: { repo: "example-org/demo-app", via: "config" },
    });
  });

  it("front matter in a fixture overrides docs-app.json", async () => {
    const view = await loadReader(fixtures(), {
      doc: "ventures/demo-app/decisions/0001-use-postgres.md",
      sourceRepo: SOURCE,
    });
    expect(view.status === "ok" && view.doc).toMatchObject({
      title: "0001: Use Postgres",
      owner: { repo: "example-org/platform", via: "front-matter" },
    });
  });

  it("a doc that isn't in the listing is 'missing', not an error", async () => {
    const view = await loadReader(fixtures(), { doc: "gone.md", sourceRepo: SOURCE });
    expect(view.status === "ok" && view.doc).toEqual({ missing: true, path: "gone.md" });
  });

  it("GitHub unreachable: 'unavailable', no crash", async () => {
    expect(
      await loadReader(createSource(createUnavailableBackend("GitHub isn't reachable")), { sourceRepo: SOURCE }),
    ).toEqual({
      status: "unavailable",
      reason: "GitHub isn't reachable",
    });
  });

  it("titles, tree order and the ?doc= parameter", () => {
    expect(titleOf("a/b.md", "---\nrepo: a/b\n---\n# Real title\n")).toBe("Real title");
    expect(titleOf("a/some-file.md", "no heading")).toBe("Some File");
    expect(titleOf("a/README.md", "no heading")).toBe("README");
    // A `# comment` inside a code block is not a title.
    expect(titleOf("a/x-y.md", "```bash\n# install\n```\n")).toBe("X Y");
    expect(
      buildTree([
        { path: "z.md", kind: "doc" },
        { path: "a/y.md", kind: "doc" },
      ]).map((n) => n.name),
    ).toEqual(["a", "z.md"]);
    expect(docParam("guides/x.md")).toBe("guides/x.md");
    for (const bad of ["../x.md", "/etc/x.md", "x.png", "a/../b.md", 3, undefined])
      expect(docParam(bad)).toBeUndefined();
  });
});
