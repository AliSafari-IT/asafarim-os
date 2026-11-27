import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocView } from "../components/DocView";
import { parseDoc } from "../lib/doc";

async function render(raw: unknown): Promise<string> {
  const r = parseDoc(raw);
  if (!r.ok) throw new Error(r.error);
  return renderToStaticMarkup(await DocView({ doc: r.doc }));
}

describe("structured article rendering", () => {
  it("renders headings with anchors, code with its language, callouts and tables", async () => {
    const html = await render({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Set up" }] },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = <T,>(a: T) => a;" }],
        },
        {
          type: "callout",
          attrs: { kind: "tip" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Hint" }] }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toContain('<h3 id="set-up">');
    expect(html).toContain('data-language="ts"');
    expect(html).toContain('class="shiki');
    expect(html).toContain("&#x3C;</span>"); // Shiki escapes the code it highlights
    expect(html).toContain('class="callout tip"');
    expect(html).toContain("<td><p><span>cell</span></p></td>");
  });

  it("renders an image from an address and from SVG code, both as <img>, never as inline markup", async () => {
    const html = await render({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://example.com/a.png", alt: "A chart", caption: "Figure 1" } },
        { type: "image", attrs: { svg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', alt: "A square" } },
      ],
    });
    expect(html).toContain(
      '<img src="https://example.com/a.png" alt="A chart" loading="lazy" decoding="async" referrerPolicy="no-referrer"/>',
    );
    expect(html).toContain("<figcaption>Figure 1</figcaption>");
    expect(html).toContain('src="data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D');
    expect(html).toContain('alt="A square"');
    // The SVG never appears as markup in the page.
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<rect");
  });

  it("escapes text that looks like HTML and never emits script or handlers", async () => {
    const html = await render({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: '<img src=x onerror="alert(1)"><script>alert(1)</script>' }],
        },
        { type: "codeBlock", content: [{ type: "text", text: "</code></pre><script>alert(2)</script>" }] },
        {
          type: "paragraph",
          content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x.example" } }] }],
        },
      ],
    });
    expect(html).not.toMatch(/<script|<img|<[^>]*\son\w+=/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="https://x.example/" rel="noopener noreferrer nofollow">');
  });
  it("renders a diagram's source as fallback text and escapes its caption", async () => {
    const html = await render({
      type: "doc",
      content: [
        {
          type: "mermaid",
          attrs: {
            source: 'flowchart LR\n  A["Request & response"] --> B',
            description: "Request goes to <server>.",
          },
        },
      ],
    });
    expect(html).toContain('aria-label="Diagram source"');
    expect(html).toContain("Request &amp; response");
    expect(html).toContain("<figcaption>Request goes to &lt;server&gt;.</figcaption>");
    expect(html).not.toContain("<svg");
  });
});
