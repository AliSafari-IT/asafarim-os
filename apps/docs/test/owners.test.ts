import { describe, expect, it } from "vitest";
import { frontMatterRepo, globToRegExp, ownerOf, parseOwnersConfig, type OwnersConfig } from "../lib/owners";

const config: OwnersConfig = {
  owners: [
    { path: "ventures/asafarim-os/**", repo: "AliSafari-IT/asafarim-os" },
    { path: "ventures/*/notes.md", repo: "example-org/notes" },
    { path: "**", repo: "AliSafari-IT/asafarim-docs" },
  ],
};
const FALLBACK = "AliSafari-IT/source";

describe("which repository owns a document (#78)", () => {
  it("the first matching path wins", () => {
    expect(ownerOf("ventures/asafarim-os/adr/0001.md", { config, fallbackRepo: FALLBACK })).toEqual({
      repo: "AliSafari-IT/asafarim-os",
      via: "config",
    });
    // Matches rule 2 and rule 3: rule 2 comes first.
    expect(ownerOf("ventures/other/notes.md", { config, fallbackRepo: FALLBACK }).repo).toBe("example-org/notes");
    expect(ownerOf("operations/runbook.md", { config, fallbackRepo: FALLBACK }).repo).toBe(
      "AliSafari-IT/asafarim-docs",
    );
  });

  it("front matter overrides the config", () => {
    const markdown = "---\ntitle: X\nrepo: AliSafari-IT/asafarim-platform\n---\n# X\n";
    expect(ownerOf("ventures/asafarim-os/x.md", { config, markdown, fallbackRepo: FALLBACK })).toEqual({
      repo: "AliSafari-IT/asafarim-platform",
      via: "front-matter",
    });
  });

  it("with no match (or no config) the source repo owns it", () => {
    const narrow: OwnersConfig = { owners: [{ path: "ventures/**", repo: "a/b" }] };
    expect(ownerOf("guides/x.md", { config: narrow, fallbackRepo: FALLBACK })).toEqual({
      repo: FALLBACK,
      via: "fallback",
    });
    expect(ownerOf("guides/x.md", { fallbackRepo: FALLBACK }).via).toBe("fallback");
  });

  it("front matter only counts at the very top, and only with a valid owner/name", () => {
    expect(frontMatterRepo("# Title\n---\nrepo: a/b\n---\n")).toBeUndefined();
    expect(frontMatterRepo("---\nrepo: not a repo\n---\n")).toBeUndefined();
    expect(frontMatterRepo("---\nrepo: 'a-b/c.d' # comment\n---\n")).toBe("a-b/c.d");
    expect(frontMatterRepo("---\r\nrepo: a/b\r\n---\r\nbody")).toBe("a/b");
    expect(frontMatterRepo("no front matter")).toBeUndefined();
  });

  it("globs: * is one segment, ** any depth (and the folder itself)", () => {
    expect(globToRegExp("ventures/*/x.md").test("ventures/a/x.md")).toBe(true);
    expect(globToRegExp("ventures/*/x.md").test("ventures/a/b/x.md")).toBe(false);
    expect(globToRegExp("ventures/**").test("ventures/a/b/c.md")).toBe(true);
    expect(globToRegExp("ventures/**/x.md").test("ventures/x.md")).toBe(true);
    expect(globToRegExp("ventures/**").test("venturesX/a.md")).toBe(false);
    expect(globToRegExp("a.md").test("aXmd")).toBe(false); // the dot is literal
  });
});

describe("docs-app.json", () => {
  it("parses a valid file", () => {
    expect(parseOwnersConfig(JSON.stringify(config))).toEqual({ ok: true, config });
  });

  it("a broken file is a clear error, not an exception", () => {
    expect(parseOwnersConfig("{ nope")).toEqual({ ok: false, error: "docs-app.json isn't valid JSON" });
    const badRepo = parseOwnersConfig(JSON.stringify({ owners: [{ path: "**", repo: "nope" }] }));
    expect(badRepo).toEqual({ ok: false, error: expect.stringMatching(/owners\.0\.repo must be owner\/name/) });
    expect(parseOwnersConfig(JSON.stringify({ owners: [], extra: 1 })).ok).toBe(false);
    expect(parseOwnersConfig(JSON.stringify({})).ok).toBe(false);
  });
});
