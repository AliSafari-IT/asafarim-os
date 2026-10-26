/**
 * The `#word` tags of a study note's Markdown (Flow, ADR 0001): what `docs.note.created.v1` carries
 * instead of the note's body, and how `#issue` asks Flow to draft a GitHub issue. Pure: no I/O.
 *
 * A tag is `#` and 1–40 letters, digits or hyphens (starting with a letter or digit), lower-cased.
 * Not a tag: anything in a fenced code block or inline code, a URL or a link's destination
 * (`https://x.test/#a`, `[see](#a)`), and a `#` that ends a word or a heading marker (`C#`, `a#b`,
 * `##a`, `\#a`). A tag longer than 40 characters is dropped, never cut.
 */

export const MAX_TAGS = 10;

const TAG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An opening code fence: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** What may come right before a tag's `#`: nothing, a space, or punctuation that opens a phrase. */
const BEFORE = String.raw`(?<=^|[\s(\[{*_~>"'])`;
const CANDIDATE = new RegExp(String.raw`${BEFORE}#([\p{L}\p{N}][\p{L}\p{N}-]*)(?![\p{L}\p{N}]|_[\p{L}\p{N}])`, "gu");

/** Inline code: a run of backticks up to the next run of the same length. */
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
/** A URL with a scheme, or one that starts with `www.`. */
const URL_TEXT = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
/** A link's or an image's destination: `](…)`. */
const LINK_DESTINATION = /\]\([^)]*\)/g;

/** The note's lines outside fenced code blocks (an unclosed fence runs to the end, as in CommonMark). */
function proseOf(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const open = FENCE.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = undefined;
      continue;
    }
    if (open) {
      fence = open;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** The distinct tags of `markdown`, lower-cased, in the order first seen, at most {@link MAX_TAGS}. */
export function tagsOf(markdown: string): string[] {
  const text = proseOf(markdown).replace(INLINE_CODE, " ").replace(LINK_DESTINATION, "] ").replace(URL_TEXT, " ");
  const tags: string[] = [];
  for (const [, word] of text.matchAll(CANDIDATE)) {
    const tag = word!.toLowerCase();
    if (!TAG.test(tag) || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}
