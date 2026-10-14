/**
 * What the AI is told when a note becomes a GitHub issue (#82): the note and the text it quotes, the
 * section it belongs to (its heading path and readable text), the document's title and outline, the
 * issue links of that section and the target repo's labels. At most about 2 000 words: the note and
 * the quote are kept whole (the notes schema caps them), the outline is cut first, then the section.
 * Pure: no I/O, so the same context is built in tests and on the server.
 */
import GithubSlugger from "github-slugger";
import type { Nodes, Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { bodyOf, headingsOf, issueLinksBySection, titleOf } from "./outline";

export const MAX_CONTEXT_WORDS = 2000;

export interface SectionText {
  /** The heading id on the page; "" for the text before the first heading. */
  id: string;
  /** The headings above it and its own, outermost first, e.g. ["Decision", "3. Two loops"]. */
  path: string[];
  /** The section's readable text: no raw HTML, no images, no Mermaid source. */
  text: string;
}

/** The text of a node as a reader sees it, with the spaces kept (unlike the squashed anchor text). */
function readable(node: Nodes): string {
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
    case "break":
      return "\n";
    default: {
      if (!("children" in node)) return "";
      const sep = node.type === "paragraph" || node.type === "heading" || node.type === "tableCell" ? "" : "\n";
      return (node.children as Nodes[]).map(readable).join(sep);
    }
  }
}

const tidy = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

/** The document split at its headings, with the same ids the page gives them (see `sectionsOf`). */
export function sectionTexts(markdown: string): SectionText[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(bodyOf(markdown)) as Root;
  const slugger = new GithubSlugger();
  const stack: { depth: number; title: string }[] = [];
  const sections: (SectionText & { parts: string[] })[] = [{ id: "", path: [], text: "", parts: [] }];
  for (const node of tree.children) {
    if (node.type === "heading") {
      const title = mdastToString(node, { includeImageAlt: false }).trim();
      while (stack.length && stack.at(-1)!.depth >= node.depth) stack.pop();
      stack.push({ depth: node.depth, title });
      sections.push({ id: slugger.slug(title), path: stack.map((h) => h.title), text: "", parts: [] });
    } else {
      sections.at(-1)!.parts.push(readable(node));
    }
  }
  return sections.map(({ parts, ...s }) => ({ ...s, text: tidy(parts.join("\n")) }));
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const wordCount = (text: string) => words(text).length;

/** The first `max` words of a text, marked as cut when it was. */
function firstWords(text: string, max: number): string {
  if (max <= 0) return "";
  const w = words(text);
  if (w.length <= max) return text;
  return `${w.slice(0, max).join(" ")} […]`;
}

export interface IssueContext {
  docPath: string;
  title: string;
  /** The document's headings, indented by level ("  - " per level below 2). */
  outline: string[];
  headingPath: string[];
  sectionText: string;
  quote: string;
  note: string;
  issueLinks: string[];
  repo: string;
  labels: string[];
  /** Words in everything above: at most about MAX_CONTEXT_WORDS. */
  words: number;
}

export function buildIssueContext(input: {
  docPath: string;
  markdown: string;
  note: { headingId: string; quote: string; body: string };
  repo: string;
  labels: string[];
  maxWords?: number;
}): IssueContext {
  const max = input.maxWords ?? MAX_CONTEXT_WORDS;
  const { markdown, note } = input;
  const sections = sectionTexts(markdown);
  // A heading that is gone (the document changed) falls back to the text before the first heading.
  const section = sections.find((s) => s.id === note.headingId) ?? sections[0]!;
  const title = titleOf(input.docPath, markdown);
  const fullOutline = headingsOf(markdown).map((h) => `${"  ".repeat(Math.max(0, h.level - 2))}- ${h.text}`);
  const issueLinks = issueLinksBySection(markdown)[section.id] ?? [];

  const fixed =
    wordCount(note.body) +
    wordCount(note.quote) +
    wordCount(title) +
    wordCount(section.path.join(" ")) +
    issueLinks.length +
    input.labels.length;
  let budget = Math.max(0, max - fixed);

  const sectionWords = wordCount(section.text);
  // The section matters more than the outline: the outline gets what the section leaves.
  const sectionText = firstWords(section.text, budget);
  budget -= Math.min(sectionWords, budget);
  const outline: string[] = [];
  for (const line of fullOutline) {
    const n = wordCount(line);
    if (n > budget) break;
    outline.push(line);
    budget -= n;
  }

  const context: Omit<IssueContext, "words"> = {
    docPath: input.docPath,
    title,
    outline,
    headingPath: section.path,
    sectionText,
    quote: note.quote,
    note: note.body,
    issueLinks,
    repo: input.repo,
    labels: input.labels,
  };
  return { ...context, words: wordCount(contextText(context)) };
}

/** The context as the AI reads it. */
export function contextText(c: Omit<IssueContext, "words">): string {
  const lines = [
    `Target repository: ${c.repo}`,
    `Document: ${c.title} (${c.docPath})`,
    "",
    "Outline:",
    ...(c.outline.length ? c.outline : ["(not included)"]),
    "",
    `Section: ${c.headingPath.length ? c.headingPath.join(" › ") : "(before the first heading)"}`,
    c.sectionText || "(empty)",
    "",
    `Selected text: ${c.quote || "(none: the note is on the whole section)"}`,
    "",
    "Owner's note:",
    c.note,
    "",
    `Related issues in this section: ${c.issueLinks.length ? c.issueLinks.join(", ") : "(none)"}`,
    `Existing labels in ${c.repo}: ${c.labels.length ? c.labels.join(", ") : "(none)"}`,
  ];
  return lines.join("\n");
}
