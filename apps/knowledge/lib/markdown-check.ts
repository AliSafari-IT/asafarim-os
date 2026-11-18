/**
 * Before a Markdown revision (Phase 0) is opened in the structured editor, say what the conversion would drop
 * (#356): raw HTML, images, footnotes and other constructs the document model doesn't have. The editor converts
 * the Markdown itself; this only names what won't survive, so nothing is lost silently.
 */
import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const LABELS: Record<string, string> = {
  html: "raw HTML",
  image: "images",
  imageReference: "images",
  footnoteDefinition: "footnotes",
  footnoteReference: "footnotes",
  definition: "link reference definitions",
  linkReference: "reference-style links",
  math: "math",
  inlineMath: "math",
  yaml: "front matter",
};

/** The distinct kinds of content a Markdown body has that the structured editor would drop, in a stable order. */
export function markdownLosses(markdown: string): string[] {
  if (!markdown.trim()) return [];
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root;
  const found = new Set<string>();
  const visit = (n: Root | RootContent) => {
    const label = LABELS[n.type];
    if (label) found.add(label);
    if (n.type === "list" && n.children.some((li) => li.checked !== null && li.checked !== undefined)) {
      found.add("task list checkboxes");
    }
    if ("children" in n) for (const c of n.children as RootContent[]) visit(c);
  };
  visit(tree);
  return [...found].sort();
}
