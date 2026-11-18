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
});
