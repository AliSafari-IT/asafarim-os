/**
 * Where a study note belongs in a document (#81). A note is anchored by its heading id AND the text it
 * quotes, never by line numbers: an edit above it moves lines, not headings or sentences.
 *
 * Text is compared with every whitespace character removed, on the server (from the Markdown) and in
 * the browser (from the rendered page) alike, so line breaks, table cells and the spaces a selection
 * picks up between blocks never decide whether a quote is still there.
 */
import GithubSlugger from "github-slugger";
import type { Nodes, Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { bodyOf } from "./outline";
import { squash } from "./quote";

export { findQuote, squash, type TextPoint } from "./quote";

export interface Section {
  /** The heading's id on the page; "" for the text before the first heading. */
  id: string;
  title: string;
  /** Squashed text of the heading and everything up to the next heading. */
  text: string;
}

/** The text a reader sees for a node: no raw HTML (never rendered), no image alt, no Mermaid source. */
function visibleText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "code":
      return node.lang === "mermaid" ? "" : node.value;
    case "html":
    case "image":
    case "imageReference":
      return "";
    default:
      return "children" in node ? (node.children as Nodes[]).map(visibleText).join(" ") : "";
  }
}

/**
 * The document split at its headings, as the page renders it (under the title): each heading's id is
 * the one rehype-slug gives it (github-slugger over the heading's text, deduplicated in order).
 */
export function sectionsOf(markdown: string): Section[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(bodyOf(markdown)) as Root;
  const slugger = new GithubSlugger();
  const sections: Section[] = [{ id: "", title: "", text: "" }];
  for (const node of tree.children) {
    if (node.type === "heading") {
      const title = mdastToString(node, { includeImageAlt: false }).trim();
      sections.push({ id: slugger.slug(title), title, text: squash(visibleText(node)) });
    } else {
      sections.at(-1)!.text += squash(visibleText(node));
    }
  }
  return sections;
}

export interface Anchored {
  /** "changed": the quoted text (or the heading) isn't in the document any more. */
  status: "ok" | "changed";
  /** The section the note shows under: where its quote is now, else its own heading, else the top. */
  headingId: string;
}

/**
 * Where a note shows in the current version of its document. Its quote in its own section: there. In
 * another section (the text moved): that one. Nowhere: kept, under its heading (or at the top when the
 * heading is gone too), marked "text changed". A note on a whole heading has no quote: it is "changed"
 * only when the heading is gone.
 */
export function anchorNote(note: { headingId: string; quote: string }, sections: Section[]): Anchored {
  const own = sections.find((s) => s.id === note.headingId);
  const quote = squash(note.quote);
  if (!quote) return own ? { status: "ok", headingId: own.id } : { status: "changed", headingId: "" };
  if (own?.text.includes(quote)) return { status: "ok", headingId: own.id };
  const moved = sections.find((s) => s.text.includes(quote));
  if (moved) return { status: "ok", headingId: moved.id };
  return { status: "changed", headingId: own ? own.id : "" };
}
