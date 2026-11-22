import { describe, expect, it } from "vitest";
import { allTokens, codeTokens, isCodeLike, queryTerms } from "../lib/identifiers";
import { buildProjection } from "../lib/search-index";
import { snippetParts, MATCH_END, MATCH_START, normaliseFilters } from "../lib/search";
import { createLimiter } from "../lib/rate-limit";

describe("identifiers", () => {
  it("recognises code-like tokens in prose and leaves plain words out", () => {
    for (const t of [
      "useEffect",
      "ERR_CONNECTION_RESET",
      "C#",
      "C++",
      "Array.prototype.map",
      "http2",
      "utf-8",
      "snake_case",
    ]) {
      expect(isCodeLike(t), t).toBe(true);
    }
    for (const t of ["React", "hooks", "The", "a", "HTTP", "Node"]) expect(isCodeLike(t), t).toBe(false);
    expect(codeTokens("Call useEffect when ERR_CONNECTION_RESET happens in C# or Node.")).toEqual([
      "useeffect",
      "err_connection_reset",
      "c#",
    ]);
  });

  it("keeps every token of code, and of a query", () => {
    expect(allTokens("const x = fetch(url)")).toEqual(["const", "fetch", "url"]);
    expect(queryTerms("  C# records  C#")).toEqual(["c#", "records"]);
  });
});

describe("the search projection of a revision", () => {
  it("splits at headings with their public anchors, and collects identifiers from code", () => {
    const p = buildProjection({
      format: "tiptap",
      title: "Hooks",
      summary: "",
      body: "",
      doc: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Intro text." }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "The effect hook" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Use " },
              { type: "text", text: "useLayoutEffect", marks: [{ type: "code" }] },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "ts" },
            content: [{ type: "text", text: "const ref = useRef(null)" }],
          },
        ],
      },
    });
    expect(p.sections.map((s) => [s.anchor, s.heading])).toEqual([
      [null, ""],
      ["the-effect-hook", "The effect hook"],
    ]);
    expect(p.terms).toEqual(expect.arrayContaining(["uselayouteffect", "useref", "const", "ref"]));
  });

  it("reads Markdown revisions too: headings, code spans and fences", () => {
    const p = buildProjection({
      format: "markdown",
      doc: null,
      title: "T",
      summary: "",
      body: "# Start\nUse `npm ci`.\n```\nERR_REQUIRE_ESM\n```",
    });
    expect(p.sections.map((s) => s.heading)).toEqual(["Start"]);
    expect(p.terms).toEqual(expect.arrayContaining(["npm", "ci", "err_require_esm"]));
  });
});

describe("search helpers", () => {
  it("renders snippet marks as parts, never as markup", () => {
    expect(snippetParts(`a ${MATCH_START}<b>${MATCH_END} c`)).toEqual([
      { text: "a ", match: false },
      { text: "<b>", match: true },
      { text: " c", match: false },
    ]);
  });

  it("drops malformed facets", () => {
    expect(normaliseFilters({ topic: "Web", level: "expert", language: "eng", kind: "video", tag: "a b" })).toEqual({
      topic: "web",
      tag: null,
      technology: null,
      level: null,
      language: null,
      kind: null,
    });
  });

  it("rate limits a client after its burst and refills over time", () => {
    const l = createLimiter({ perMinute: 60, burst: 2 });
    expect(l.take("a", 0).ok).toBe(true);
    expect(l.take("a", 0).ok).toBe(true);
    expect(l.take("a", 0)).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(l.take("b", 0).ok).toBe(true);
    expect(l.take("a", 1_000).ok).toBe(true);
  });
});
