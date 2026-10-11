import "server-only";
/**
 * A document, rendered on the server (#80): GitHub-flavoured Markdown (tables, task lists), raw HTML
 * never rendered, everything through rehype-sanitize's default schema first; then links and images
 * resolved inside the listing, the leading title left to the page, heading ids and anchors, shiki for code and Mermaid blocks handed to
 * the browser.
 */
import { MarkdownAsync, type Components } from "react-markdown";
import type { PluggableList } from "unified";
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { getSingletonHighlighter } from "shiki";
import { bodyOf } from "@/lib/outline";
import { rehypeDocLinks, rehypeMermaid, rehypeTaskLabels } from "@/lib/rehype";
import { Mermaid } from "./Mermaid";

// GitHub's current palettes: every token keeps WCAG AA contrast on its background (the classic
// github-light/dark themes don't, e.g. their orange and comment greys).
const THEMES = { light: "github-light-default", dark: "github-dark-default" } as const;
// The usual languages up front; any other bundled one loads when a document uses it.
const LANGS = ["bash", "shell", "json", "yaml", "ts", "tsx", "js", "jsx", "sql", "diff", "md", "css", "html"];

const highlighter = () => getSingletonHighlighter({ themes: Object.values(THEMES), langs: LANGS });

const components: Components = {
  div({ node: _node, ...props }) {
    const source = (props as Record<string, unknown>)["data-mermaid"];
    if (typeof source === "string") return <Mermaid source={source}>{props.children}</Mermaid>;
    return <div {...props} />;
  },
  table({ node: _node, ...props }) {
    // Wide tables scroll on their own instead of the page.
    return (
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Table">
        <table {...props} />
      </div>
    );
  },
};

/**
 * `variant: "note"` renders a study note's body (#81) through the same pipeline, untrusted alike, but
 * whole (no title to drop) and without heading ids, so a note can't take an id the document uses.
 */
export async function Markdown({
  markdown,
  fromDoc,
  docs,
  images,
  variant = "document",
}: {
  markdown: string;
  fromDoc: string;
  docs: string[];
  images: string[];
  variant?: "document" | "note";
}) {
  const shiki = await highlighter();
  const headings: PluggableList =
    variant === "document"
      ? [
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: "append",
              properties: { className: ["anchor"], ariaHidden: true, tabIndex: -1 },
              content: { type: "text", value: "#" },
            },
          ],
        ]
      : [];
  return (
    <MarkdownAsync
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[
        // Untrusted content: sanitized before anything else touches it (raw HTML is never parsed).
        rehypeSanitize,
        [rehypeDocLinks, { fromDoc, docs: new Set(docs), images: new Set(images) }],
        rehypeMermaid,
        rehypeTaskLabels,
        ...headings,
        [
          rehypeShikiFromHighlighter,
          shiki,
          { themes: THEMES, defaultColor: false, lazy: true, fallbackLanguage: "text", addLanguageClass: true },
        ],
      ]}
      components={components}
    >
      {variant === "document" ? bodyOf(markdown) : markdown}
    </MarkdownAsync>
  );
}
