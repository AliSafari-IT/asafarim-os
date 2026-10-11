import { describe, expect, it } from "vitest";
import { docHref, fileHref, resolveLink, resolvePath } from "../lib/links";

const paths = {
  docs: new Set(["index.md", "a/b.md", "a/c/d.md", "a/with space.md"]),
  images: new Set(["images/x.svg"]),
};

describe("links inside a document (#80)", () => {
  it("resolves relative paths and refuses to climb past the root", () => {
    expect(resolvePath("a/c/d.md", "../b.md")).toBe("a/b.md");
    expect(resolvePath("a/c/d.md", "./e/../f.md")).toBe("a/c/f.md");
    expect(resolvePath("a/b.md", "/index.md")).toBe("index.md");
    expect(resolvePath("a/b.md", "../../x.md")).toBeNull();
    expect(resolvePath("index.md", "..")).toBeNull();
  });

  it("documents open in the app, images go through /api/files, hashes stay", () => {
    expect(resolveLink("a/c/d.md", "../b.md#part", paths)).toEqual({ kind: "doc", path: "a/b.md", hash: "#part" });
    expect(resolveLink("a/b.md", "with%20space.md", paths)).toEqual({ kind: "doc", path: "a/with space.md", hash: "" });
    expect(resolveLink("a/c/d.md", "../../images/x.svg", paths)).toEqual({ kind: "image", path: "images/x.svg" });
    expect(resolveLink("a/b.md", "#top", paths)).toEqual({ kind: "hash", hash: "#top" });
    expect(docHref("a/with space.md", "#p")).toBe("/?doc=a%2Fwith%20space.md#p");
    expect(fileHref("images/a b.svg")).toBe("/api/files/images/a%20b.svg");
  });

  it("external links are http(s) and mailto only", () => {
    expect(resolveLink("a/b.md", "https://example.com/x", paths)).toEqual({
      kind: "external",
      href: "https://example.com/x",
    });
    expect(resolveLink("a/b.md", "mailto:someone@example.com", paths).kind).toBe("external");
  });

  it("anything else is not a link", () => {
    for (const href of [
      undefined,
      "",
      "#",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,x",
      "//evil.example/x",
      "../../../outside.md",
      "missing.md",
      "%E0%A4%A.md",
      "../c/d.txt",
    ]) {
      expect(resolveLink("a/b.md", href, paths), String(href)).toEqual({ kind: "none" });
    }
  });
});
