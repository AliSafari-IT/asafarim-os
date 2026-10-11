/**
 * What the reader shows around a document (#80), from its Markdown: the title, the "On this page"
 * headings, the reading time and word count, the GitHub issue links of each section, and readable
 * names for files and folders. The extraction is `@asafarim/markdown-utils`; this module only feeds it
 * the prose (no front matter, no code blocks) and turns headings into the ids the renderer gives them.
 */
import {
  extractLinks,
  filenameToTitle,
  getAllHeadings,
  getFirstHeading,
  getReadingTime,
  getWordCount,
} from "@asafarim/markdown-utils";
import GithubSlugger from "github-slugger";

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
// A fenced block: ``` or ~~~ (3+), up to the same fence or the end of the document.
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const ISSUE_LINK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+(?:[#?].*)?$/;

/** The Markdown without its front matter (rendered and measured without it). */
export const stripFrontMatter = (markdown: string) => markdown.replace(FRONT_MATTER, "");

const LEADING_TITLE = /^\s*(?: {0,3}#[ \t]+[^\n]*)(?:\n|$)/;

/**
 * What the page renders under the title: no front matter, and no leading `# ` heading (the page
 * shows the title itself, so there's one h1 and heading ids don't count it).
 */
export const bodyOf = (markdown: string) => stripFrontMatter(markdown).replace(LEADING_TITLE, "");

/** The prose: no front matter and no fenced code, whose `# comments` aren't headings. */
export const proseOf = (markdown: string) => stripFrontMatter(markdown).replace(FENCE, "");

/**
 * Inline HTML dropped from a heading: from a `<` that starts a tag (a letter, `/` or `!` follows) to
 * its `>`, nested too, so a split tag like `<scr<script>ipt>` can't leave one behind; a lone `<` or
 * `>` (as in "a < b") is text. A scanner, not a regex. The text is never HTML anyway: React escapes it.
 */
function stripTags(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "<" && /[A-Za-z/!]/.test(text[i + 1] ?? "")) depth++;
    else if (ch === ">" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** A heading as it reads on the page: inline Markdown dropped, as the renderer's text is. */
export function plainHeading(raw: string): string {
  const linksDropped = raw
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return stripTags(linksDropped)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .trim();
}

export interface Heading {
  level: number;
  text: string;
  /** The id rehype-slug gives the heading (github-slugger, deduplicated in document order). */
  id: string;
}

/** Every heading under the title in document order, with the id it has on the page. */
export function headingsOf(markdown: string): Heading[] {
  const slugger = new GithubSlugger();
  return getAllHeadings(proseOf(bodyOf(markdown)), 6).map((h) => {
    const text = plainHeading(h.text);
    return { level: h.level, text, id: slugger.slug(text) };
  });
}

/** The table of contents: the h2 and h3 headings (the h1 is the title). */
export const tocOf = (headings: Heading[]) => headings.filter((h) => h.level === 2 || h.level === 3);

/** A file or folder name made readable: `example-app` → `Example App`, `roadmap.md` → `Roadmap`. */
export function readableName(name: string): string {
  if (/^readme\.md$/i.test(name)) return "README";
  return filenameToTitle(name.replace(/\.md$/i, "")) || name;
}

/** The document's title: its first `# ` heading, else its file name made readable. */
export function titleOf(docPath: string, markdown: string): string {
  return plainHeading(getFirstHeading(proseOf(markdown))) || readableName(docPath.split("/").at(-1)!);
}

/** `ventures/example-app/roadmap/x.md` → ["Ventures", "Example App", "Roadmap"]. */
export const breadcrumbOf = (docPath: string) => docPath.split("/").slice(0, -1).map(readableName);

export interface DocStats {
  words: number;
  minutes: number;
}

export function statsOf(markdown: string): DocStats {
  const prose = proseOf(markdown);
  return { words: getWordCount(prose), minutes: Math.max(1, getReadingTime(prose)) };
}

/**
 * The GitHub issue and pull request links of each section (by heading id; "" before the first
 * heading): extra context for turning a note into an issue (#82).
 */
export function issueLinksBySection(markdown: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const slugger = new GithubSlugger();
  let section = "";
  for (const line of proseOf(bodyOf(markdown)).split("\n")) {
    const h = /^ {0,3}#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      section = slugger.slug(plainHeading(h[1]!));
      continue;
    }
    for (const { url } of extractLinks(line)) {
      if (!ISSUE_LINK.test(url)) continue;
      const list = (out[section] ??= []);
      if (!list.includes(url)) list.push(url);
    }
  }
  return out;
}
