import { describe, expect, it } from "vitest";
import { parseDoc } from "../lib/doc";
import { buildProjection } from "../lib/search-index";

describe("buildProjection", () => {
  it("keeps list items and table cells apart, inline runs together", () => {
    const p = parseDoc({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: ["PostgreSQL", "Redis"].map((w) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: w }] }],
          })),
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "use" },
            { type: "text", text: "Effect", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    if (!p.ok) throw new Error(p.error);
    const out = buildProjection({ format: "tiptap", doc: p.doc, title: "Stack", summary: "", body: p.text });
    expect(out.body.split("\n")).toEqual(["PostgreSQL", "Redis", "useEffect"]);
  });

  it("leaves HTML comments in Markdown out, as the page does", () => {
    const out = buildProjection({
      format: "markdown",
      doc: null,
      title: "Notes",
      summary: "",
      body: "Visible <!-- hidden one --> text\n<!-- spans\nlines -->\nafter\n```\n<!-- code keeps it -->\n```",
    });
    expect(out.body).not.toMatch(/hidden|spans|lines -->/);
    expect(out.body).toContain("Visible  text");
    expect(out.body).toContain("after");
    expect(out.body).toContain("<!-- code keeps it -->");
  });
});
