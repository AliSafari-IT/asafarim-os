/**
 * The picture an article card shows beside its title (home page list). Articles have no cover field of their own
 * (only courses do, lib/courses.ts), so the card uses the first image in the published revision: the first image
 * node of a structured document, or the first `![alt](address)` of a Markdown body. Only sources the article page
 * itself would show qualify: an uploaded asset through /media/:id, an https address on a named site
 * (checkImageUrl), or SVG code that was checked when it was saved, as a data: URL. Anything else means no thumbnail,
 * and the card keeps its full-width text layout.
 */
import type { DocNode } from "./doc";
import { checkImageUrl, isAssetId, svgDataUrl } from "./media/validate";

export interface Thumbnail {
  src: string;
  alt: string;
}

function fromDoc(doc: DocNode): Thumbnail | null {
  if (doc.type === "image") {
    const a = doc.attrs ?? {};
    const alt = typeof a.alt === "string" ? a.alt : "";
    if (isAssetId(a.asset)) return { src: `/media/${a.asset}`, alt };
    const src = checkImageUrl(a.src);
    if (src) return { src, alt };
    if (typeof a.svg === "string" && a.svg) return { src: svgDataUrl(a.svg), alt };
    return null;
  }
  for (const c of doc.content ?? []) {
    const found = fromDoc(c);
    if (found) return found;
  }
  return null;
}

/** Code is not content: an image written inside a fence or backticks is an example, not a picture. */
const stripCode = (md: string) =>
  md.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "").replace(/`+[^`\n]*`+/g, "");

const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

function fromMarkdown(body: string): Thumbnail | null {
  for (const m of stripCode(body).matchAll(MD_IMAGE)) {
    const alt = m[1]!.trim();
    const address = m[2]!;
    const asset = /^\/media\/([^/?#]+)$/.exec(address)?.[1];
    if (asset && isAssetId(asset)) return { src: `/media/${asset}`, alt };
    const src = checkImageUrl(address);
    if (src) return { src, alt };
  }
  return null;
}

export function articleThumbnail(article: {
  format: "markdown" | "tiptap";
  doc: DocNode | null;
  body: string;
}): Thumbnail | null {
  if (article.format === "tiptap") return article.doc ? fromDoc(article.doc) : null;
  return fromMarkdown(article.body);
}
