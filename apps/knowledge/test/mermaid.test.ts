import { describe, expect, it } from "vitest";
import { checkMermaid, parseDoc } from "../lib/doc";

describe("Mermaid diagrams in documents", () => {
  it("accepts the known diagram types", () => {
    for (const s of [
      "flowchart TD\n  A --> B",
      "sequenceDiagram\n  A->>B: hi",
      "%% a comment\nerDiagram\n  A ||--o{ B : has",
      "stateDiagram-v2\n  [*] --> S",
    ]) {
      expect(checkMermaid(s), s).toMatchObject({ ok: true });
    }
  });

  it("refuses directives, front matter, interactions, HTML and unknown types", () => {
    expect(checkMermaid('%%{ init: { "theme": "dark" } }%%\nflowchart TD\nA-->B')).toEqual({
      ok: false,
      error: "mermaid_config",
    });
    expect(checkMermaid("---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\nA-->B")).toEqual({
      ok: false,
      error: "mermaid_config",
    });
    expect(checkMermaid("flowchart TD\nA-->B\nclick A callback")).toEqual({ ok: false, error: "mermaid_interaction" });
    expect(checkMermaid("flowchart TD\nA[<b>x</b>]-->B")).toEqual({ ok: false, error: "mermaid_html" });
    expect(checkMermaid("flowchart TD\nA[javascript:x]-->B")).toEqual({ ok: false, error: "mermaid_html" });
    expect(checkMermaid("hello world")).toEqual({ ok: false, error: "mermaid_type" });
    expect(checkMermaid("flowchart TD\n" + "A-->B\n".repeat(300))).toEqual({ ok: false, error: "mermaid_too_large" });
  });

  it("stores a diagram node with its description, and refuses an unsafe one", () => {
    const ok = parseDoc({
      type: "doc",
      content: [{ type: "mermaid", attrs: { source: "flowchart LR\nA-->B", description: "A then B", onload: "x" } }],
    });
    expect(ok).toEqual({
      ok: true,
      doc: {
        type: "doc",
        content: [{ type: "mermaid", attrs: { source: "flowchart LR\nA-->B", description: "A then B" } }],
      },
      text: "A then B",
    });
    expect(
      parseDoc({
        type: "doc",
        content: [{ type: "mermaid", attrs: { source: "%%{init:{}}%%\nflowchart LR\nA-->B" } }],
      }),
    ).toEqual({
      ok: false,
      error: "mermaid_config",
    });
  });
  it("checks the exact character and line limits after normalizing line endings", () => {
    const header = "flowchart TD\n";
    const atCharacterLimit = header + "A".repeat(5000 - header.length);
    expect(checkMermaid(atCharacterLimit)).toEqual({ ok: true, source: atCharacterLimit });
    expect(checkMermaid(atCharacterLimit + "A")).toEqual({ ok: false, error: "mermaid_too_large" });

    const lines = ["flowchart TD", ...Array<string>(199).fill("  A --> B")];
    expect(checkMermaid(lines.join("\r\n"))).toEqual({ ok: true, source: lines.join("\n") });
    expect(checkMermaid([...lines, "  B --> C"].join("\r\n"))).toEqual({
      ok: false,
      error: "mermaid_too_large",
    });
  });

  it("keeps captions in reading order and leaves diagram syntax out of the article text", () => {
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const source = "flowchart LR\n  A --> B";
    expect(
      parseDoc({
        type: "doc",
        content: [
          paragraph("Before"),
          { type: "mermaid", attrs: { source, description: "  Request flows to the server.  " } },
          { type: "mermaid", attrs: { source } },
          paragraph("After"),
        ],
      }),
    ).toMatchObject({ ok: true, text: "Before\nRequest flows to the server.\nAfter" });
  });

  it("checks the caption limit and rejects a Mermaid block with child nodes", () => {
    const attrs = { source: "flowchart LR\n  A --> B", description: "x".repeat(500) };
    expect(parseDoc({ type: "doc", content: [{ type: "mermaid", attrs }] })).toMatchObject({
      ok: true,
      text: attrs.description,
    });
    expect(
      parseDoc({
        type: "doc",
        content: [{ type: "mermaid", attrs: { ...attrs, description: attrs.description + "x" } }],
      }),
    ).toEqual({ ok: false, error: "mermaid_description_too_long" });
    expect(
      parseDoc({ type: "doc", content: [{ type: "mermaid", attrs, content: [{ type: "text", text: "unexpected" }] }] }),
    ).toEqual({ ok: false, error: "doc_invalid" });
  });
});
