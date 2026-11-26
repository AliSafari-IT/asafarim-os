/**
 * Pasting from another page (a browser, a document, a wiki) into the article editor. The editor already turns
 * pasted HTML into its own document (only the nodes and marks it knows, see lib/doc.ts) and the server parses that
 * document again before storing it, so no pasted HTML, style or script is ever kept. What this adds is the part of
 * the arrangement the editor would otherwise lose:
 *
 * - Headings: a page's h1 to h6 become the editor's three levels, keeping their order. The highest heading in the
 *   pasted part becomes a section heading (level 2), the next ones below it, the rest the lowest level (4). Without
 *   this an h1, h5 or h6 would land as plain text.
 * - Images that point at another site can't be kept as they are (an article only shows media from its own store,
 *   so readers are never tracked by, or broken by, another site). They are taken out and counted, so the editor
 *   can say how many to upload. An image already in this store (copied inside the editor) stays.
 *
 * Pure and DOM-based: it runs in the editor (the browser's DOMParser) and in tests (jsdom's).
 */

export interface PastedHtml {
  html: string;
  /** Images from another site that were taken out. */
  droppedImages: number;
}

export const EDITOR_HEADING_LEVELS = [2, 3, 4] as const;

const HEADINGS = "h1, h2, h3, h4, h5, h6";

/** Map a source heading level to the editor's: the highest one present becomes 2, the next 3, the rest 4. */
export function headingLevel(level: number, highest: number): number {
  const min = EDITOR_HEADING_LEVELS[0];
  const max = EDITOR_HEADING_LEVELS[EDITOR_HEADING_LEVELS.length - 1]!;
  return Math.min(Math.max(min + (level - highest), min), max);
}

export function normalizePastedHtml(html: string, parser: DOMParser = new DOMParser()): PastedHtml {
  const doc = parser.parseFromString(html, "text/html");
  const body = doc.body;
  // Copied inside an editor of this app: already in the editor's own levels and media, so left exactly as it is.
  if (body.querySelector("[data-pm-slice]")) return { html, droppedImages: 0 };

  const headings = [...body.querySelectorAll<HTMLElement>(HEADINGS)];
  if (headings.length) {
    const levels = headings.map((h) => Number(h.tagName.slice(1)));
    const highest = Math.min(...levels);
    headings.forEach((h, i) => {
      const target = `h${headingLevel(levels[i]!, highest)}`;
      if (h.tagName.toLowerCase() === target) return;
      const next = doc.createElement(target);
      for (const a of [...h.attributes]) next.setAttribute(a.name, a.value);
      while (h.firstChild) next.appendChild(h.firstChild);
      h.replaceWith(next);
    });
  }

  let droppedImages = 0;
  for (const img of [...body.querySelectorAll("img")]) {
    if (img.closest("figure[data-image]")) continue; // one of this store's images, copied inside the editor
    const parent = img.parentElement;
    img.remove();
    droppedImages++;
    // A paragraph or link that only held the image would be left as an empty line.
    // Only wrappers: a table cell stays, or the table would lose its shape.
    if (parent?.matches("p, a, span, picture, figure") && !parent.textContent?.trim() && !parent.querySelector("img")) {
      parent.remove();
    }
  }

  return { html: body.innerHTML, droppedImages };
}

/** Whether pasted HTML carries text (not only images or empty wrappers). */
export function hasText(html: string, parser: DOMParser = new DOMParser()): boolean {
  return (parser.parseFromString(html, "text/html").body.textContent ?? "").trim().length > 0;
}
