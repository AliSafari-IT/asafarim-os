/**
 * Finding a note's quote in text (#81), without dependencies: the browser uses it over the page's
 * text nodes, so it stays out of the Markdown parser's bundle. Whitespace never counts.
 */

/** The text with every whitespace character removed: what quotes are compared on. */
export const squash = (text: string) => text.replace(/\s+/g, "");

/** A position in a list of text segments (the page's text nodes, in order). */
export interface TextPoint {
  segment: number;
  offset: number;
}

/**
 * The first place `quote` occurs in the segments, starting at segment `from` (the first text after the
 * note's heading) and, failing that, anywhere: [start, end) as segment offsets, whitespace ignored.
 */
export function findQuote(segments: string[], quote: string, from = 0): [TextPoint, TextPoint] | null {
  const needle = squash(quote);
  if (!needle) return null;
  const points: TextPoint[] = [];
  let hay = "";
  segments.forEach((text, segment) => {
    for (let offset = 0; offset < text.length; offset++) {
      if (/\s/.test(text[offset]!)) continue;
      hay += text[offset];
      points.push({ segment, offset });
    }
  });
  const startAt = points.findIndex((p) => p.segment >= from);
  let at = startAt === -1 ? -1 : hay.indexOf(needle, startAt);
  if (at === -1) at = hay.indexOf(needle);
  if (at === -1) return null;
  const last = points[at + needle.length - 1]!;
  return [points[at]!, { segment: last.segment, offset: last.offset + 1 }];
}
