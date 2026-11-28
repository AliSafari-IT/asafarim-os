import { describe, expect, it } from "vitest";
import type { DocNode } from "../lib/doc";
import { articleThumbnail } from "../lib/thumbnail";

const ASSET = "0b7c6f8e-2a4d-4c1e-9f3a-5d6e7f8a9b0c";
const doc = (...content: DocNode[]): DocNode => ({ type: "doc", content });
const para = (t: string): DocNode => ({ type: "paragraph", content: [{ type: "text", text: t }] });
const tiptap = (d: DocNode | null) => articleThumbnail({ format: "tiptap", doc: d, body: "" });
const md = (body: string) => articleThumbnail({ format: "markdown", doc: null, body });

describe("an article card's thumbnail", () => {
  it("is the first image of a structured document, wherever it sits", () => {
    const d = doc(
      para("Intro"),
      {
        type: "blockquote",
        content: [{ type: "image", attrs: { src: "https://images.example.com/a.png", alt: "First" } }],
      },
      { type: "image", attrs: { asset: ASSET, alt: "Second" } },
    );
    expect(tiptap(d)).toEqual({ src: "https://images.example.com/a.png", alt: "First" });
  });

  it("serves an uploaded image through /media and SVG code as a data: URL", () => {
    expect(tiptap(doc({ type: "image", attrs: { asset: ASSET, alt: "Up" } }))).toEqual({
      src: `/media/${ASSET}`,
      alt: "Up",
    });
    const svg = tiptap(doc({ type: "image", attrs: { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', alt: "S" } }));
    expect(svg?.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  });

  it("is null for a document without an image, or none at all", () => {
    expect(tiptap(doc(para("Only text")))).toBeNull();
    expect(tiptap(null)).toBeNull();
  });

  it("is the first usable image of a Markdown body", () => {
    expect(
      md('Text\n\n![A chart](https://cdn.example.org/chart.webp "Title")\n\n![B](https://x.example.org/b.png)'),
    ).toEqual({ src: "https://cdn.example.org/chart.webp", alt: "A chart" });
    expect(md(`![Up](/media/${ASSET})`)).toEqual({ src: `/media/${ASSET}`, alt: "Up" });
  });

  it("skips Markdown images an article page wouldn't show, or that are only code", () => {
    expect(md("![x](http://insecure.example.com/a.png)")).toBeNull();
    expect(md("![x](https://127.0.0.1/a.png) ![y](javascript:alert(1))")).toBeNull();
    expect(md("```md\n![x](https://cdn.example.org/a.png)\n```\nand `![y](https://cdn.example.org/b.png)`")).toBeNull();
    expect(md("```\n![x](https://cdn.example.org/a.png)\n```\n![z](https://cdn.example.org/z.png)")).toEqual({
      src: "https://cdn.example.org/z.png",
      alt: "z",
    });
    expect(md("No pictures here.")).toBeNull();
  });
});
