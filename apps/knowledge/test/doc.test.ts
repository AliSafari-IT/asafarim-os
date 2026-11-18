import { describe, expect, it } from "vitest";
import { EMPTY_DOC, headingIds, LIMITS, parseDoc, safeHref, safeLanguage, type Doc } from "../lib/doc";

const p = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: unknown[]) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });

describe("the article document", () => {
  it("accepts every node the editor offers and derives plain text", () => {
    const doc = p(
      { type: "heading", attrs: { level: 2 }, content: [text("Hooks")] },
      para(text("Use "), text("useEffect", [{ type: "code" }]), text(" carefully.")),
      { type: "codeBlock", attrs: { language: "TS" }, content: [text("const a = 1;")] },
      { type: "bulletList", content: [{ type: "listItem", content: [para(text("one"))] }] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [para(text("three"))] }] },
      { type: "callout", attrs: { kind: "warning" }, content: [para(text("Careful"))] },
      { type: "blockquote", content: [para(text("quote"))] },
      { type: "horizontalRule" },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [para(text("h"))] },
            ],
          },
          { type: "tableRow", content: [{ type: "tableCell", content: [para(text("c"))] }] },
        ],
      },
    );
    const r = parseDoc(JSON.stringify(doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe("Hooks\nUse useEffect carefully.\nconst a = 1;\none\nthree\nCareful\nquote\nh\nc");
    expect(r.doc.content[2]!.attrs).toEqual({ language: "ts" });
    expect(r.doc.content[5]!.attrs).toEqual({ kind: "warning" });
    expect(r.doc.content[8]!.content![0]!.content![0]!.attrs).toEqual({ colspan: 1, rowspan: 1 });
  });

  it("refuses unknown node and mark types, misplaced nodes and non-documents", () => {
    for (const bad of [
      p({ type: "iframe", attrs: { src: "https://evil.example" } }),
      p({ type: "image", attrs: { src: "x" } }),
      p(para(text("x", [{ type: "script" }]))),
      p(text("bare text at the top")),
      p({ type: "listItem", content: [para(text("no list"))] }),
      p({ type: "bulletList", content: [para(text("not an item"))] }),
      p(para({ type: "paragraph" })),
      p(para({ type: "text", text: "" })),
      { type: "paragraph" },
      "not json",
      42,
      null,
    ]) {
      expect(parseDoc(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it("drops unknown attributes and unsafe links, keeping the text", () => {
    const r = parseDoc(
      p(
        {
          type: "paragraph",
          attrs: { style: "color:red", onclick: "x()" },
          content: [text("a", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])],
        },
        para(text("b", [{ type: "link", attrs: { href: "https://example.com/x", target: "_blank", class: "evil" } }])),
        { type: "heading", attrs: { level: 9, id: "x" }, content: [text("h")] },
        { type: "codeBlock", attrs: { language: "<script>" }, content: [text("x", [{ type: "bold" }])] },
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "a" }] });
    expect(r.doc.content[1]!.content![0]!.marks).toEqual([{ type: "link", attrs: { href: "https://example.com/x" } }]);
    expect(r.doc.content[2]!.attrs).toEqual({ level: 2 });
    expect(r.doc.content[3]).toEqual({
      type: "codeBlock",
      attrs: { language: null },
      content: [{ type: "text", text: "x" }],
    });
  });

  it("bounds size and depth", () => {
    let deep: unknown = para(text("x"));
    for (let i = 0; i < LIMITS.depth + 2; i++) deep = { type: "blockquote", content: [deep] };
    expect(parseDoc(p(deep))).toEqual({ ok: false, error: "doc_too_deep" });
    const many = p(...Array.from({ length: LIMITS.nodes }, () => para(text("x"))));
    expect(parseDoc(many)).toEqual({ ok: false, error: "doc_too_large" });
    expect(parseDoc(p(para(text("x".repeat(LIMITS.text + 1)))))).toEqual({ ok: false, error: "doc_too_large" });
  });

  it("gives an empty document one paragraph", () => {
    expect(parseDoc({ type: "doc", content: [] })).toEqual({ ok: true, doc: EMPTY_DOC, text: "" });
  });

  it("allows only safe link targets and code labels", () => {
    expect(safeHref("https://a.example/x?y=1")).toBe("https://a.example/x?y=1");
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeHref("/articles/x")).toBe("/articles/x");
    expect(safeHref("#section-2")).toBe("#section-2");
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.example",
      "/\\evil",
      "vbscript:x",
      "#a b",
      "",
      3,
    ]) {
      expect(safeHref(bad), String(bad)).toBeNull();
    }
    expect(safeLanguage("C#")).toBe("c#");
    expect(safeLanguage("c++")).toBe("c++");
    expect(safeLanguage("x y")).toBeNull();
  });

  it("gives headings unique anchors", () => {
    const r = parseDoc(
      p(
        { type: "heading", attrs: { level: 2 }, content: [text("Set up")] },
        { type: "heading", attrs: { level: 3 }, content: [text("Set up")] },
        { type: "heading", attrs: { level: 2 }, content: [text("¿Qué?")] },
      ),
    );
    if (!r.ok) throw new Error(r.error);
    expect([...headingIds(r.doc as Doc).values()]).toEqual(["set-up", "set-up-2", "que"]);
  });
});
