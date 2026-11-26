// @vitest-environment jsdom
/**
 * Pasting from another page: the HTML a browser puts on the clipboard goes through the editor's paste handling
 * (lib/paste.ts, lib/rich-paste.ts), the server's document check (lib/doc.ts) and the published page (DocView),
 * and comes out with the same structure and emphasis, and with nothing executable.
 */
import { Blob as NodeBlob } from "node:buffer";
import { Editor } from "@tiptap/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocView } from "../components/DocView";
import { parseDoc } from "../lib/doc";
import { textExtensions } from "../lib/editor-extensions";
import { headingLevel, normalizePastedHtml } from "../lib/paste";
import { RichPaste } from "../lib/rich-paste";

// jsdom has no layout and no ClipboardEvent constructor; ProseMirror's paste only needs the event to exist.
document.createRange = () => {
  const r = new Range();
  Object.assign(r, { getBoundingClientRect: () => ({}), getClientRects: () => [] });
  return r;
};
class FakeClipboardEvent extends Event {
  clipboardData: DataTransfer | null = null;
}
// Shiki (the page's code highlighting) loads its engine through a Blob stream, which jsdom's Blob lacks.
Object.assign(globalThis, { ClipboardEvent: FakeClipboardEvent, Blob: NodeBlob });

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function paste(html: string, onDroppedImages: (n: number) => void = () => undefined) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [...textExtensions(), RichPaste.configure({ onImageFiles: null, onDroppedImages })],
  });
  (editor.view as unknown as { pasteHTML(h: string): boolean }).pasteHTML(html);
  const parsed = parseDoc(editor.getJSON());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.doc;
}

// Roughly what Chrome puts on the clipboard for a selection of an article: computed inline styles, wrappers,
// a meta tag, a script and event handlers that must not survive.
const FROM_CHROME = `<meta charset="utf-8"><div style="font-family: Inter"><h1 style="color: rgb(0,0,0); font-size: 32px">Getting started</h1>
<p style="text-align: center">A <span style="font-weight: 700">bold</span> and <span style="font-style: italic">italic</span> start, with <u>underline</u>, <s>strike</s>, <mark>a highlight</mark>, H<sub>2</sub>O and E = mc<sup>2</sup>.</p>
<h2>Install</h2><p>Run <code>pnpm install</code>, then read <a href="https://example.com/docs" onclick="steal()">the docs</a> or <a href="javascript:alert(1)">this</a>.</p>
<h3>Options</h3><ol start="3"><li>Third<ul><li>nested</li></ul></li><li>Fourth</li></ol>
<blockquote><p>Quoted</p></blockquote>
<pre><code class="language-ts">const a = 1;
const b = 2;</code></pre>
<table><thead><tr><th>Name</th><th style="text-align: right">Size</th></tr></thead><tbody><tr><td>one</td><td style="text-align: right">10</td></tr></tbody></table>
<p><img src="https://tracker.example.com/pixel.png" alt="Diagram"></p>
<h5>Small print</h5><script>alert(1)</script><p onmouseover="x()">The end</p></div>`;

describe("pasting from another page", () => {
  it("maps any heading levels onto the editor's three, keeping their order", () => {
    expect([1, 2, 3, 4, 5, 6].map((l) => headingLevel(l, 1))).toEqual([2, 3, 4, 4, 4, 4]);
    expect([2, 3, 4].map((l) => headingLevel(l, 2))).toEqual([2, 3, 4]);
    expect(headingLevel(5, 5)).toBe(2);
    const r = normalizePastedHtml("<h3>a</h3><h4>b</h4><h6>c</h6>");
    expect(r.html).toBe("<h2>a</h2><h3>b</h3><h4>c</h4>");
  });

  it("leaves the editor's own clipboard alone (copying a section inside an article keeps its levels)", () => {
    const own = '<h3 data-pm-slice="1 1 []">Sub</h3><h4>Deeper</h4>';
    expect(normalizePastedHtml(own)).toEqual({ html: own, droppedImages: 0 });
  });

  it("takes out images from another site and counts them, but keeps this store's own", () => {
    const r = normalizePastedHtml(
      `<p>a<img src="https://x.example/a.png"></p><img src="data:image/png;base64,AAAA"><figure data-image asset="x"><img src="/media/x"></figure>`,
    );
    expect(r.droppedImages).toBe(2);
    expect(r.html).toContain("figure");
    expect(r.html).toContain('src="/media/x"');
    expect(r.html).not.toContain("x.example");
  });

  it("keeps the structure and emphasis through the editor, the server check and the page", async () => {
    const dropped = vi.fn();
    const doc = paste(FROM_CHROME, dropped);
    expect(dropped).toHaveBeenCalledWith(1);

    const types = doc.content.map((n) => (n.type === "heading" ? `h${n.attrs?.level}` : n.type));
    expect(types).toEqual([
      "h2",
      "paragraph",
      "h3",
      "paragraph",
      "h4",
      "orderedList",
      "blockquote",
      "codeBlock",
      "table",
      "h4",
      "paragraph",
    ]);
    expect(doc.content[1]!.attrs).toEqual({ textAlign: "center" });
    expect(doc.content[5]!.attrs).toEqual({ start: 3 });
    expect(doc.content[7]!.attrs).toEqual({ language: "ts" });

    const html = renderToStaticMarkup(await DocView({ doc }));
    expect(html).toContain('<p style="text-align:center">');
    expect(html).toMatch(/<strong>bold<\/strong>/);
    expect(html).toMatch(/<em>italic<\/em>/);
    expect(html).toMatch(/<u>underline<\/u>/);
    expect(html).toMatch(/<s>strike<\/s>/);
    expect(html).toMatch(/<mark>a highlight<\/mark>/);
    expect(html).toContain("<span>, H</span><span><sub>2</sub></span><span>O");
    expect(html).toMatch(/<sup>2<\/sup>/);
    expect(html).toMatch(/<code>pnpm install<\/code>/);
    expect(html).toContain('<a href="https://example.com/docs" rel="noopener noreferrer nofollow">the docs</a>');
    expect(html).toContain('<ol start="3"><li><p><span>Third</span></p><ul><li><p><span>nested</span></p>');
    expect(html).toContain("<blockquote>");
    expect(html).toContain('data-language="ts"');
    expect(html).toContain('<th><p><span>Name</span></p></th><th style="text-align:right">');
    expect(html).toContain('<td style="text-align:right">');
    expect(html).toContain("Small print");

    // Nothing executable or tracking survives.
    for (const bad of ["javascript:", "onclick", "onmouseover", "<script", "steal", "tracker.example.com", "font-"]) {
      expect(html).not.toContain(bad);
    }
    // The unsafe link keeps its text, without the link.
    expect(html).toContain("<span> or this.</span>");
  });
});

describe("the server check for the new formatting", () => {
  const p = (content: unknown[]) => parseDoc({ type: "doc", content });

  it("keeps only the known alignments, and never the default", () => {
    const r = p([
      { type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "a" }] },
      { type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "b" }] },
      { type: "paragraph", attrs: { textAlign: "red; background:url(x)" }, content: [{ type: "text", text: "c" }] },
      { type: "heading", attrs: { level: 2, textAlign: "right" }, content: [{ type: "text", text: "d" }] },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.content.map((n) => n.attrs)).toEqual([
      { textAlign: "center" },
      undefined,
      undefined,
      { level: 2, textAlign: "right" },
    ]);
  });

  it("accepts highlight, subscript and superscript, never both of the last two at once", () => {
    const r = p([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "x", marks: [{ type: "highlight", attrs: { color: "red" } }] },
          { type: "text", text: "y", marks: [{ type: "subscript" }, { type: "superscript" }] },
        ],
      },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.content[0]!.content!.map((t) => t.marks)).toEqual([[{ type: "highlight" }], [{ type: "subscript" }]]);
  });

  it("keeps a table cell's alignment only when it is center or right", () => {
    const cell = (align: unknown) => ({
      type: "tableCell",
      attrs: { align },
      content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
    });
    const r = p([
      { type: "table", content: [{ type: "tableRow", content: [cell("right"), cell("left"), cell("x")] }] },
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(r.doc.content[0]!.content![0]!.content!.map((c) => c.attrs)).toEqual([
      { colspan: 1, rowspan: 1, align: "right" },
      { colspan: 1, rowspan: 1 },
      { colspan: 1, rowspan: 1 },
    ]);
  });
});
