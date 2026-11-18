import { describe, expect, it } from "vitest";
import { markdownLosses } from "../lib/markdown-check";

describe("Markdown conversion warnings", () => {
  it("names what the structured editor would drop", () => {
    expect(
      markdownLosses(
        "# T\n\n<div>raw</div>\n\n![alt](x.png)\n\nText[^1]\n\n[^1]: note\n\n- [x] done\n\n[ref]: https://x.example",
      ),
    ).toEqual(["footnotes", "images", "link reference definitions", "raw HTML", "task list checkboxes"]);
  });

  it("is silent for what converts cleanly", () => {
    expect(
      markdownLosses(
        "## Hi\n\nSome *text* with `code` and a [link](https://x.example).\n\n```ts\nx\n```\n\n| a |\n| - |\n| 1 |",
      ),
    ).toEqual([]);
    expect(markdownLosses("")).toEqual([]);
  });
});
