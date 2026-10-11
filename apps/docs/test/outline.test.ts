import { describe, expect, it } from "vitest";
import {
  bodyOf,
  breadcrumbOf,
  headingsOf,
  issueLinksBySection,
  plainHeading,
  readableName,
  statsOf,
  titleOf,
  tocOf,
} from "../lib/outline";

const DOC = `---
repo: example-org/x
---
# The **title**

Intro with a [link](https://github.com/example-org/x/issues/1).

## Set up \`pnpm\`

\`\`\`bash
# not a heading
echo hi
\`\`\`

### Details

See https://github.com/example-org/x/pull/2 and [again](https://github.com/example-org/x/pull/2).

## Set up \`pnpm\`

#### Deep
`;

describe("the outline of a document (#80)", () => {
  it("title, body and headings: no front matter, no code comments, ids as rendered", () => {
    expect(titleOf("a/x.md", DOC)).toBe("The title");
    expect(bodyOf(DOC).startsWith("\nIntro")).toBe(true);
    expect(headingsOf(DOC)).toEqual([
      { level: 2, text: "Set up pnpm", id: "set-up-pnpm" },
      { level: 3, text: "Details", id: "details" },
      { level: 2, text: "Set up pnpm", id: "set-up-pnpm-1" },
      { level: 4, text: "Deep", id: "deep" },
    ]);
    expect(tocOf(headingsOf(DOC)).map((h) => h.id)).toEqual(["set-up-pnpm", "details", "set-up-pnpm-1"]);
  });

  it("an h2 that repeats the title keeps the id the page gives it", () => {
    expect(headingsOf("# Overview\n\n## Overview\n")).toEqual([{ level: 2, text: "Overview", id: "overview" }]);
  });

  it("plain heading text and readable names", () => {
    expect(plainHeading("Use [Postgres](x.md) `now` ~~later~~ ##")).toBe("Use Postgres now later");
    expect(readableName("example-app")).toBe("Example App");
    expect(readableName("roadmap.md")).toBe("Roadmap");
    expect(readableName("README.md")).toBe("README");
    expect(breadcrumbOf("ventures/demo-app/roadmap/x.md")).toEqual(["Ventures", "Demo App", "Roadmap"]);
    expect(breadcrumbOf("index.md")).toEqual([]);
  });

  it("stats count the prose and never say 0 minutes", () => {
    const stats = statsOf(DOC);
    expect(stats.minutes).toBe(1);
    expect(stats.words).toBeGreaterThan(5);
    expect(stats.words).toBeLessThan(40);
  });

  it("GitHub issue and PR links per section", () => {
    expect(issueLinksBySection(DOC)).toEqual({
      "": ["https://github.com/example-org/x/issues/1"],
      details: ["https://github.com/example-org/x/pull/2"],
    });
  });
});
