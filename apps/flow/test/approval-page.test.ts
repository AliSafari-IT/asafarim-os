/**
 * What the approval page builds from an untrusted draft: the link to its document in Docs (from the
 * config, each segment encoded, nothing that leaves Docs' root) and the body's preview (sanitized: no
 * raw HTML, no script, no javascript: link, no image fetched; external links rel="noopener noreferrer").
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Preview } from "../components/Preview";
import { docsLink } from "../lib/docs-link";

vi.mock("../lib/platform", () => ({ getPlatform: () => ({ config: { getString: () => "https://docs.example" } }) }));

describe("the link to the document in Docs", () => {
  it("is <docs.url>/<docPath>, from the config, each segment encoded", () => {
    expect(docsLink("guides/getting-started.md")).toBe("https://docs.example/guides/getting-started.md");
    expect(docsLink("guides/a b#c?.md", "http://docs.localhost:8080")).toBe(
      "http://docs.localhost:8080/guides/a%20b%23c%3F.md",
    );
    expect(docsLink("index.md", "https://host/docs")).toBe("https://host/docs/index.md");
  });

  it("is left out for a path that would leave Docs' root, or a base that isn't http(s)", () => {
    for (const p of ["../secrets", "a/../../b", "/etc/passwd", "a//b", "./a"]) expect(docsLink(p)).toBeUndefined();
    expect(docsLink("//evil.example/x")).toBeUndefined();
    expect(docsLink("a.md", "javascript:alert(1)")).toBeUndefined();
    expect(docsLink("a.md", "not a url")).toBeUndefined();
  });
});

describe("the preview of the body", () => {
  const html = (md: string) => renderToStaticMarkup(createElement(Preview, { markdown: md }));

  it("renders GitHub-flavoured Markdown", () => {
    const out = html("## Context\n\n- [ ] a task\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`code`");
    expect(out).toContain("<h2>Context</h2>");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("<table>");
    expect(out).toContain("<code>code</code>");
  });

  it("never renders raw HTML, scripts or javascript: links", () => {
    const out = html(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))\n\n<a href="https://x" onclick="y">x</a>',
    );
    expect(out).not.toMatch(/<script|onerror|onclick|javascript:/i);
    expect(out).not.toContain("<img");
  });

  it("external links open with rel=noopener noreferrer; relative ones lose the link; images aren't fetched", () => {
    const out = html(
      "[site](https://example.com/a) [rel](../a.md) [top](#context) ![a cat](https://img.example/c.png)",
    );
    expect(out).toContain('<a href="https://example.com/a" rel="noopener noreferrer" target="_blank">site</a>');
    expect(out).toContain('<span class="dead-link">rel</span>');
    expect(out).toContain('href="#');
    expect(out).toContain('<span class="missing-image">[image: a cat]</span>');
    expect(out).not.toContain("img.example");
  });
});
