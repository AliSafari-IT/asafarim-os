/**
 * The rehype step that runs after rehype-sanitize on a draft's body (components/Preview.tsx): it only
 * rewrites what is already safe. An absolute http(s) link opens in a new tab with
 * `rel="noopener noreferrer"`; a link to a heading of the body stays; anything else (a relative path,
 * which GitHub would resolve against the repository, not Flow) keeps its words and loses the link. An
 * image is never fetched by the preview (the approver's browser would call a host the draft chose):
 * it shows as its alt text.
 */
import type { Element, ElementContent, Root } from "hast";
import { visit } from "unist-util-visit";

const text = (value: string): ElementContent => ({ type: "text", value });

export function rehypeDraftLinks() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName === "a") {
        const href = String(node.properties.href ?? "");
        if (/^https?:\/\//i.test(href)) {
          node.properties.rel = ["noopener", "noreferrer"];
          node.properties.target = "_blank";
        } else if (!href.startsWith("#") && !/^mailto:/i.test(href)) {
          node.tagName = "span";
          node.properties = { className: ["dead-link"] };
        }
      } else if (node.tagName === "img") {
        const alt = String(node.properties.alt ?? "").trim();
        node.tagName = "span";
        node.properties = { className: ["missing-image"] };
        node.children = [text(alt ? `[image: ${alt}]` : "[image]")];
      }
    });
  };
}
