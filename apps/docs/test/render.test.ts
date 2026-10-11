import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown";
import { headingsOf } from "../lib/outline";
import { hasMermaid } from "../lib/rehype";

const DOCS = ["index.md", "ventures/demo-app/overview.md", "ventures/demo-app/decisions/0001-use-postgres.md"];
const IMAGES = ["images/diagram.svg"];

async function render(markdown: string, fromDoc = "ventures/demo-app/roadmap/roadmap.md") {
  const el = await Markdown({ markdown, fromDoc, docs: DOCS, images: IMAGES });
  // MarkdownAsync is an async component, so it renders with the streaming (static) renderer.
  const { prelude } = await prerender(createElement("div", null, el));
  return new Response(prelude).text();
}

describe("rendering a document (#80)", () => {
  it("the roadmap fixture: tables, task lists, code, Mermaid, links and the image", async () => {
    const md = readFileSync(
      path.resolve(import.meta.dirname, "../fixtures/ventures/demo-app/roadmap/roadmap.md"),
      "utf8",
    );
    const html = await render(md);
    // The title is the page's; the body starts below it.
    expect(html).not.toContain("<h1");
    expect(html).toContain('<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table>');
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled="" aria-label="Write the plan" checked=""/>',
    );
    expect(html).toContain('href="/?doc=ventures%2Fdemo-app%2Foverview.md"');
    expect(html).toContain('href="/?doc=ventures%2Fdemo-app%2Fdecisions%2F0001-use-postgres.md#decision"');
    expect(html).toContain('src="/api/files/images/diagram.svg"');
    expect(html).toContain('<span class="dead-link"');
    expect(html).not.toContain("outside.md");
    expect(html).toContain(
      'href="https://github.com/example-org/demo-app/issues/12" rel="noopener noreferrer" target="_blank"',
    );
    // shiki on the server, both themes as variables; the bash comment stays code.
    expect(html).toContain('<pre class="shiki shiki-themes github-light-default github-dark-default"');
    expect(html).toContain('<code class="language-bash"><span class="line"><span style="--shiki-light:#6E7781');
    expect(html).toContain("--shiki-dark:");
    // Mermaid: the source, readable before the browser draws it, and not highlighted.
    expect(html).toContain('data-testid="mermaid"');
    expect(html).toContain("gantt");
    expect(html).not.toMatch(/language-mermaid/);
    expect(hasMermaid(md)).toBe(true);
    // Every heading the table of contents links to exists with that id.
    for (const h of headingsOf(md)) expect(html).toContain(`id="${h.id}"`);
  });

  it("raw HTML and script URLs never render", async () => {
    const html = await render(
      [
        "<script>alert(1)</script>",
        '<img src="x" onerror="alert(1)">',
        "[click](javascript:alert(1))",
        "![x](data:image/svg+xml,<svg/onload=alert(1)>)",
        "![remote](https://example.com/track.png)",
        "[proto](//evil.example/x)",
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script|onerror|onload|javascript:|data:image|evil\.example|example\.com\/track/i);
    expect(html).toContain('<span class="missing-image">[image: remote]</span>');
  });

  it("an unknown language falls back to plain text", async () => {
    const html = await render("```nosuchlang\nplain <b>\n```\n");
    expect(html).toContain("plain &lt;b&gt;");
  });
});
