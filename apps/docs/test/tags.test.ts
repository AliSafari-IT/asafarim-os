/**
 * The `#word` tags of a study note (Flow, ADR 0001): what `docs.note.created.v1` carries instead
 * of the body, and how `#issue` asks for a GitHub issue.
 */
import { describe, expect, it } from "vitest";
import { MAX_TAGS, tagsOf } from "../lib/tags";

describe("tagsOf: what counts as a tag", () => {
  it.each([
    ["one tag", "Ask Team B #issue", ["issue"]],
    ["at the start of the note", "#issue ask Team B", ["issue"]],
    ["at the start of a line", "first line\n#todo second", ["todo"]],
    ["digits and hyphens", "#v2 #follow-up #2026-q4", ["v2", "follow-up", "2026-q4"]],
    ["followed by punctuation", "see #issue, #todo. (#later) #now!", ["issue", "todo", "later", "now"]],
    ["inside emphasis or a quote", '**#bold** _#under_ > #quoted "#said"', ["bold", "under", "quoted", "said"]],
    ["in a list item", "- #one\n* #two\n1. #three", ["one", "two", "three"]],
    ["after a tab", "x\t#tab", ["tab"]],
    ["exactly 40 characters", `#${"a".repeat(40)}`, ["a".repeat(40)]],
  ])("finds %s", (_what, markdown, tags) => {
    expect(tagsOf(markdown)).toEqual(tags);
  });

  it("is case-insensitive and lower-cases", () => {
    expect(tagsOf("#Issue #TODO #MixedCase")).toEqual(["issue", "todo", "mixedcase"]);
  });

  it("de-duplicates in the order first seen, whatever the case", () => {
    expect(tagsOf("#b #a #B #issue #A #Issue")).toEqual(["b", "a", "issue"]);
  });

  it(`keeps at most ${MAX_TAGS}, the first ones`, () => {
    const many = Array.from({ length: 15 }, (_, i) => `#t${i}`).join(" ");
    expect(tagsOf(many)).toEqual(Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`));
    // Duplicates don't use up the cap.
    expect(tagsOf(`#a #a #a ${many}`)).toHaveLength(MAX_TAGS);
    expect(tagsOf(`#a #a #a ${many}`)[1]).toBe("t0");
  });

  it("finds none in a note without tags", () => {
    expect(tagsOf("")).toEqual([]);
    expect(tagsOf("Ask Team B about the beta.")).toEqual([]);
  });
});

describe("tagsOf: what isn't a tag", () => {
  it.each([
    ["a # ending a word", "I write C# and F#", []],
    ["a # inside a word", "a#b x#issue", []],
    ["a heading marker", "# Issue\n## issue\n### Notes", []],
    ["a # right after another #", "##issue ###todo", []],
    ["an escaped #", String.raw`\#issue`, []],
    ["an HTML entity", "&#123; &#x41;", []],
    ["a lone #", "# , #- #_x", []],
    ["a word starting with a hyphen", "#-issue", []],
    ["a word with an underscore", "#snake_case", []],
    ["a word with a non-ASCII letter", "#café #naïve", []],
    ["longer than 40 characters (never cut)", `#${"a".repeat(41)}`, []],
  ])("ignores %s", (_what, markdown, tags) => {
    expect(tagsOf(markdown)).toEqual(tags);
  });

  it("ignores URLs and link destinations", () => {
    const md = [
      "https://example.test/page#issue",
      "<https://example.test/#todo>",
      "www.example.test/#later",
      "[see](#section) [doc](other.md#issue) ![img](a.svg#frag)",
      "[#real](https://example.test/#nope)",
    ].join("\n");
    // A link's TEXT is prose: `#real` is a tag.
    expect(tagsOf(md)).toEqual(["real"]);
  });

  it("ignores inline code, with one or more backticks", () => {
    expect(tagsOf("`#issue` and ``a `#b` c`` but #real")).toEqual(["real"]);
    // An unmatched backtick isn't code.
    expect(tagsOf("a ` #real")).toEqual(["real"]);
  });

  it("ignores fenced code blocks, with backticks or tildes", () => {
    const md = [
      "#before",
      "```ts",
      "const x = 1; // #issue",
      "```",
      "~~~",
      "#todo",
      "~~~",
      "   ```",
      "#indented-fence",
      "   ```",
      "#after",
    ].join("\n");
    expect(tagsOf(md)).toEqual(["before", "after"]);
  });

  it("ends a fence only on a closing fence of the same kind and at least the same length", () => {
    const md = ["````", "```", "#inside", "~~~", "#still-inside", "````", "#outside"].join("\n");
    expect(tagsOf(md)).toEqual(["outside"]);
    // A fence with text after it doesn't close the block.
    expect(tagsOf(["```", "``` not closing", "#inside", "```", "#outside"].join("\n"))).toEqual(["outside"]);
  });

  it("treats an unclosed fence as code to the end of the note", () => {
    expect(tagsOf("#before\n```\n#issue\n#todo")).toEqual(["before"]);
  });

  it("reads Windows line endings", () => {
    expect(tagsOf("#a\r\n```\r\n#b\r\n```\r\n#c")).toEqual(["a", "c"]);
  });
});
