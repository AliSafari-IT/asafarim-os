import { describe, expect, it } from "vitest";
import { filterTree } from "../components/DocTree";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createOutcome, IssueCreatedUnsaved, PUBLIC_BANNER } from "../components/IssueDialog";
import { mermaidLabel } from "../components/Mermaid";
import type { NavNode } from "../components/nav";
import { searchDocs } from "../components/Search";
import { hashId } from "../components/Toc";
import { issueHref } from "../lib/issue-link";

const tree: NavNode[] = [
  {
    label: "Ventures",
    children: [
      {
        label: "Demo App",
        children: [
          { label: "Overview", path: "ventures/demo-app/overview.md", kind: "doc", children: [] },
          { label: "Roadmap", path: "ventures/demo-app/roadmap/roadmap.md", kind: "doc", children: [] },
        ],
      },
    ],
  },
  {
    label: "Guides",
    children: [{ label: "Getting Started", path: "guides/getting-started.md", kind: "doc", children: [] }],
  },
  { label: "Index", path: "index.md", kind: "doc", children: [] },
];

describe("the documents filter (#80)", () => {
  it("keeps matches and the folders above them", () => {
    expect(filterTree(tree, "")).toBe(tree);
    expect(filterTree(tree, "roadmap")).toEqual([
      {
        label: "Ventures",
        children: [
          {
            label: "Demo App",
            children: [{ label: "Roadmap", path: "ventures/demo-app/roadmap/roadmap.md", kind: "doc", children: [] }],
          },
        ],
      },
    ]);
    // A folder that matches keeps everything in it.
    expect(filterTree(tree, "guides")[0]!.children).toHaveLength(1);
    expect(filterTree(tree, "nothing")).toEqual([]);
  });
});

describe("⌘K search (#80)", () => {
  const docs = [
    {
      path: "ventures/demo-app/roadmap/roadmap.md",
      title: "Demo app roadmap",
      crumbs: ["Ventures", "Demo App", "Roadmap"],
      headings: [
        { text: "Milestones", id: "milestones" },
        { text: "Timeline", id: "timeline" },
      ],
    },
    { path: "guides/getting-started.md", title: "Getting started", crumbs: ["Guides"], headings: [] },
  ];

  it("titles first, then headings, each opening at the right place", () => {
    expect(searchDocs(docs, "")).toEqual([]);
    expect(searchDocs(docs, "  ROAD ")).toEqual([
      {
        path: "ventures/demo-app/roadmap/roadmap.md",
        hash: "",
        label: "Demo app roadmap",
        context: "Ventures › Demo App › Roadmap",
      },
    ]);
    expect(searchDocs(docs, "time")).toEqual([
      {
        path: "ventures/demo-app/roadmap/roadmap.md",
        hash: "#timeline",
        label: "Timeline",
        context: "Demo app roadmap",
      },
    ]);
    expect(searchDocs(docs, "t", 2)).toHaveLength(2);
  });
});

describe("Mermaid (#80)", () => {
  it("a diagram is labelled by its title", () => {
    expect(mermaidLabel("gantt\n  title Demo app timeline\n  dateFormat YYYY-MM-DD")).toBe(
      "Diagram: Demo app timeline",
    );
    expect(mermaidLabel("graph TD\n  A --> B")).toBe("Diagram");
  });
});

describe("hashId", () => {
  it("decodes the fragment, and keeps a malformed one as written instead of throwing", () => {
    expect(hashId("#setup")).toBe("setup");
    expect(hashId("#caf%C3%A9")).toBe("café");
    expect(hashId("#%E0%A4%A")).toBe("%E0%A4%A");
    expect(hashId("")).toBe("");
  });
});

describe("Generate GitHub issue, in the page (#82)", () => {
  it("a note's issue link is only ever a GitHub issue's own URL", () => {
    expect(issueHref("https://github.com/example-org/demo-app/issues/42")).toBe(
      "https://github.com/example-org/demo-app/issues/42",
    );
    for (const bad of [
      null,
      "",
      "javascript:alert(1)",
      "https://github.com.evil.test/o/r/issues/1",
      "https://github.com/o/r/pull/1",
      "https://github.com/o/r/issues/1#x",
      "http://github.com/o/r/issues/1",
    ]) {
      expect(issueHref(bad), String(bad)).toBeUndefined();
    }
  });

  it("the public-repo banner says what the issue says", () => {
    expect(PUBLIC_BANNER).toBe("This repo is public. Everything below will be visible to everyone.");
  });

  const URL_7 = "https://github.com/example-org/demo-app/issues/7";
  const issue7 = { url: URL_7, number: 7 };

  it("a created issue whose link couldn't be saved is shown, never offered as a retry", () => {
    expect(createOutcome(201, { issue: issue7 })).toEqual({ kind: "created", url: URL_7 });
    for (const error of ["issue_url_not_saved", "note_gone"]) {
      const outcome = createOutcome(error === "note_gone" ? 410 : 500, {
        error,
        message: "The issue was created, but the link could not be saved on this note.",
        issue: issue7,
      });
      expect(outcome).toEqual({
        kind: "created_unsaved",
        url: URL_7,
        message: "The issue was created, but the link could not be saved on this note.",
      });
    }
    // A failure without an issue stays a failure.
    expect(createOutcome(502, { error: "github_unavailable", message: "GitHub isn't answering." })).toMatchObject({
      kind: "failed",
      message: "GitHub isn't answering.",
    });
  });

  it("renders the created issue's link and the message", () => {
    const html = renderToStaticMarkup(
      createElement(IssueCreatedUnsaved, {
        url: URL_7,
        message: "The issue was created, but the link could not be saved on this note.",
      }),
    );
    expect(html).toContain(`href="${URL_7}"`);
    expect(html).toContain("example-org/demo-app/issues/7");
    expect(html).toContain("The issue was created, but the link could not be saved on this note.");
    expect(html).toContain('role="alert"');
  });
});
