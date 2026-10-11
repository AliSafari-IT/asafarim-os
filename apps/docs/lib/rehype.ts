/**
 * The rehype steps that run after rehype-sanitize (#80): they only rewrite what's already safe.
 *
 * - `rehypeDocLinks`: links and images resolve against the open document (lib/links.ts). A document
 *   opens in the app, an image is served by /api/files, an external link gets
 *   `rel="noopener noreferrer"`; anything else (outside the listing, past the root, another scheme,
 *   an external image) stops being a link or an image.
 * - `rehypeMermaid`: a ```mermaid block becomes `<div data-mermaid>` holding its source as plain
 *   text, which the page draws in the browser (components/Mermaid.tsx); shiki leaves it alone.
 * - `rehypeTaskLabels`: a task-list checkbox is named by its item's text, for screen readers.
 */
import type { Element, ElementContent, Root } from "hast";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";
import { docHref, fileHref, resolveLink } from "./links";

export interface DocLinkOptions {
  fromDoc: string;
  docs: ReadonlySet<string>;
  images: ReadonlySet<string>;
}

const text = (value: string): ElementContent => ({ type: "text", value });

export function rehypeDocLinks(opts: DocLinkOptions) {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName === "a") {
        const target = resolveLink(opts.fromDoc, String(node.properties.href ?? ""), opts);
        if (target.kind === "doc") node.properties.href = docHref(target.path, target.hash);
        else if (target.kind === "image") node.properties.href = fileHref(target.path);
        else if (target.kind === "hash") node.properties.href = target.hash;
        else if (target.kind === "external") {
          node.properties.href = target.href;
          node.properties.rel = ["noopener", "noreferrer"];
          node.properties.target = "_blank";
        } else {
          // Not something this app can open: the words stay, the link goes.
          node.tagName = "span";
          node.properties = { className: ["dead-link"], title: "This link points outside the documents" };
        }
      } else if (node.tagName === "img") {
        const target = resolveLink(opts.fromDoc, String(node.properties.src ?? ""), opts);
        if (target.kind === "image") {
          node.properties.src = fileHref(target.path);
          node.properties.loading = "lazy";
          node.properties.alt ??= "";
        } else {
          const alt = String(node.properties.alt ?? "").trim();
          node.tagName = "span";
          node.properties = { className: ["missing-image"] };
          node.children = [text(alt ? `[image: ${alt}]` : "[image]")];
        }
      }
    });
  };
}

const isMermaidCode = (node: ElementContent | undefined): node is Element =>
  node?.type === "element" &&
  node.tagName === "code" &&
  Array.isArray(node.properties.className) &&
  node.properties.className.includes("language-mermaid");

export function rehypeMermaid() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "pre" || !isMermaidCode(node.children[0])) return;
      const source = toString(node.children[0]);
      node.tagName = "div";
      node.properties = { className: ["mermaid"], dataMermaid: source };
      // Without JavaScript the source stays readable.
      node.children = [
        {
          type: "element",
          tagName: "pre",
          properties: { className: ["mermaid-source"] },
          children: [{ type: "element", tagName: "code", properties: {}, children: [text(source)] }],
        },
      ];
    });
  };
}

export function rehypeTaskLabels() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      const classes = node.properties.className;
      if (node.tagName !== "li" || !Array.isArray(classes) || !classes.includes("task-list-item")) return;
      const box = node.children.find(
        (c): c is Element => c.type === "element" && c.tagName === "input" && c.properties.type === "checkbox",
      );
      if (!box) return;
      const label = toString(node).trim().split("\n")[0]!.trim();
      if (label) box.properties.ariaLabel = label;
    });
  };
}

/** True when the Markdown has a ```mermaid block (the page then loads mermaid in the browser). */
export const hasMermaid = (markdown: string) => /^ {0,3}(`{3,}|~{3,})\s*mermaid\b/m.test(markdown);
