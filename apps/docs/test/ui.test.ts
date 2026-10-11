import { describe, expect, it } from "vitest";
import { filterTree } from "../components/DocTree";
import { mermaidLabel } from "../components/Mermaid";
import type { NavNode } from "../components/nav";
import { searchDocs } from "../components/Search";
import { hashId } from "../components/Toc";

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
