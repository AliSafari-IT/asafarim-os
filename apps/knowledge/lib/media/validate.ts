/**
 * What may be uploaded and embedded (#359). Pure functions, shared by the server and the editor.
 *
 * Uploads: a short list of types, each with a size limit, and the file's first bytes must match the type it claims
 * (checked on the server after the upload, before the asset can be used). No SVG or HTML: both can carry script.
 *
 * Images without an upload (they need no media store): an https address on another site, or SVG code pasted into the
 * document. Both are only ever shown through an <img> element (an SVG as a data: URL), where a browser runs no script
 * and loads nothing an SVG refers to; the SVG check also refuses script, event handlers and foreign HTML outright.
 *
 * Videos: only YouTube and Vimeo, stored as a provider and a validated id, never as a URL or HTML. The page builds
 * the player address itself (youtube-nocookie.com, player.vimeo.com with dnt), and only after the reader asks for it.
 */

export const MEDIA_TYPES = {
  "image/png": { kind: "image", maxBytes: 10 * 1024 * 1024, ext: "png" },
  "image/jpeg": { kind: "image", maxBytes: 10 * 1024 * 1024, ext: "jpg" },
  "image/gif": { kind: "image", maxBytes: 10 * 1024 * 1024, ext: "gif" },
  "image/webp": { kind: "image", maxBytes: 10 * 1024 * 1024, ext: "webp" },
  "application/pdf": { kind: "file", maxBytes: 25 * 1024 * 1024, ext: "pdf" },
} as const;

export type MediaType = keyof typeof MEDIA_TYPES;
export type MediaKind = (typeof MEDIA_TYPES)[MediaType]["kind"];

export const MEDIA_LIMITS = {
  filename: 200,
  alt: 300,
  caption: 300,
  label: 200,
  videoTitle: 200,
  imageUrl: 2000,
  svg: 100_000,
} as const;

export const isMediaType = (t: unknown): t is MediaType => typeof t === "string" && t in MEDIA_TYPES;

export type UploadCheck =
  { ok: true; contentType: MediaType; kind: MediaKind; size: number; filename: string } | { ok: false; error: string };

/** The upload an author asks for, before any byte is sent. */
export function checkUploadRequest(input: { contentType: unknown; size: unknown; filename: unknown }): UploadCheck {
  const contentType = typeof input.contentType === "string" ? input.contentType.trim().toLowerCase() : "";
  if (!isMediaType(contentType)) return { ok: false, error: "media_type" };
  const size = typeof input.size === "number" ? input.size : Number(input.size);
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, error: "media_empty" };
  if (size > MEDIA_TYPES[contentType].maxBytes) return { ok: false, error: "media_too_large" };
  const filename = cleanFilename(input.filename, MEDIA_TYPES[contentType].ext);
  return { ok: true, contentType, kind: MEDIA_TYPES[contentType].kind, size, filename };
}

/** A display name: no path, no control characters, bounded; "file.<ext>" when nothing is left. */
export function cleanFilename(raw: unknown, ext: string): string {
  const base = (typeof raw === "string" ? raw : "").split(/[\\/]/).pop() ?? "";
  const name = [...base]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f && !'"<>'.includes(ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MEDIA_LIMITS.filename);
  return name || `file.${ext}`;
}

/** Whether the file's first bytes are what its type says. */
export function sniffMatches(contentType: MediaType, head: Uint8Array): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const ascii = (at: number, s: string) => [...s].every((ch, i) => head[at + i] === ch.charCodeAt(0));
  switch (contentType) {
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/gif":
      return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "application/pdf":
      return ascii(0, "%PDF-");
  }
}

export const SNIFF_BYTES = 16;

export const VIDEO_PROVIDERS = ["youtube", "vimeo"] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

const VIDEO_ID: Record<VideoProvider, RegExp> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  vimeo: /^[1-9]\d{0,11}$/,
};

export const isVideoId = (provider: unknown, id: unknown): provider is VideoProvider =>
  typeof provider === "string" &&
  (VIDEO_PROVIDERS as readonly string[]).includes(provider) &&
  typeof id === "string" &&
  VIDEO_ID[provider as VideoProvider].test(id);

/**
 * A video address an author pasted, as a provider and an id; null for anything else: other sites, embed or iframe
 * HTML, playlists without a video, or a malformed id.
 */
export function parseVideoUrl(raw: unknown): { provider: VideoProvider; id: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 500 || /[<>"\s]/.test(text)) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let found: { provider: VideoProvider; id: string } | null = null;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") found = { provider: "youtube", id: u.searchParams.get("v") ?? "" };
    else if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "") && parts.length === 2) {
      found = { provider: "youtube", id: parts[1]! };
    }
  } else if (host === "youtu.be" && parts.length === 1) {
    found = { provider: "youtube", id: parts[0]! };
  } else if (host === "vimeo.com" && parts.length === 1) {
    found = { provider: "vimeo", id: parts[0]! };
  } else if (host === "player.vimeo.com" && parts[0] === "video" && parts.length === 2) {
    found = { provider: "vimeo", id: parts[1]! };
  }
  return found && isVideoId(found.provider, found.id) ? found : null;
}

/** The player address for a validated video: privacy-enhanced modes, built here and nowhere else. */
export function videoEmbedUrl(provider: VideoProvider, id: string): string {
  if (!isVideoId(provider, id)) throw new Error("invalid video");
  return provider === "youtube"
    ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`
    : `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1`;
}

export const VIDEO_LABEL: Record<VideoProvider, string> = { youtube: "YouTube", vimeo: "Vimeo" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isAssetId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/**
 * An image address an author typed: https only, on a named host (no IP address, no localhost), no credentials, no
 * fragment. Returns the normalised address, or null. Readers' browsers load it from that site, so it is the author's
 * choice of host; the page sends no Referer with it.
 */
export function checkImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > MEDIA_LIMITS.imageUrl || /[\s<>"'`\\]/.test(text)) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  u.hash = "";
  return u.href.length <= MEDIA_LIMITS.imageUrl ? u.href : null;
}

const SVG_FORBIDDEN = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /<\s*iframe/i,
  /<\s*(embed|object)\b/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /<!ENTITY/i,
];

/**
 * Where the root <svg> tag starts, after an optional XML declaration, then comments and at most one doctype (without
 * an internal subset), in any order; -1 when the code doesn't start that way. A single forward scan with indexOf, so it
 * runs in linear time whatever it is given (a regular expression here could backtrack exponentially on many comments).
 */
function svgRootStart(svg: string): number {
  const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f";
  const startsAt = (at: number, word: string) => svg.slice(at, at + word.length).toLowerCase() === word;
  let at = 0;
  const skipSpace = () => {
    while (isSpace(svg[at])) at++;
  };
  if (startsAt(0, "<?xml")) {
    const end = svg.indexOf("?>", 5);
    if (end < 0) return -1;
    at = end + 2;
  }
  let doctypes = 0;
  for (;;) {
    skipSpace();
    if (startsAt(at, "<!--")) {
      const end = svg.indexOf("-->", at + 4);
      if (end < 0) return -1;
      at = end + 3;
    } else if (startsAt(at, "<!doctype")) {
      const end = svg.indexOf(">", at + 9);
      if (end < 0 || ++doctypes > 1 || svg.slice(at, end).includes("[")) return -1;
      at = end + 1;
    } else break;
  }
  const after = svg[at + 4];
  return startsAt(at, "<svg") && (isSpace(after) || after === ">" || after === "/") ? at : -1;
}

/**
 * SVG code an author pasted: one <svg> element (optionally after an XML declaration, comments and a doctype), at most
 * 100 000 characters, with no script, event handler, foreign HTML or entity declaration. Gets the SVG namespace when
 * it lacks one or names another (a mangled copy such as "http://w3.org" is common): an <img> shows nothing for an SVG
 * outside that namespace. Returns the code to store, or an error.
 */
export function checkSvg(
  raw: unknown,
): { ok: true; svg: string } | { ok: false; error: "svg_invalid" | "svg_too_large" | "svg_unsafe" } {
  if (typeof raw !== "string") return { ok: false, error: "svg_invalid" };
  let svg = raw.trim();
  if (svg.length > MEDIA_LIMITS.svg) return { ok: false, error: "svg_too_large" };
  if (svg.includes("\u0000")) return { ok: false, error: "svg_invalid" };
  const rootStart = svgRootStart(svg);
  if (rootStart < 0) return { ok: false, error: "svg_invalid" };
  // Well-formed XML from the root to the very end (`svg` is trimmed): a browser shows nothing for anything else.
  const root = scanSvgElement(svg, rootStart);
  if (!root) return { ok: false, error: "svg_invalid" };
  if (SVG_FORBIDDEN.some((re) => re.test(svg))) return { ok: false, error: "svg_unsafe" };
  const ns = root.attributes.get("xmlns");
  if (!ns) {
    svg = `${svg.slice(0, rootStart)}<svg xmlns="${SVG_NAMESPACE}"${svg.slice(rootStart + 4)}`;
  } else if (svg.slice(ns.from, ns.to) !== SVG_NAMESPACE) {
    svg = `${svg.slice(0, ns.from)}${SVG_NAMESPACE}${svg.slice(ns.to)}`;
  }
  // The namespace counts towards the limit too: what is stored must pass this check again.
  if (svg.length > MEDIA_LIMITS.svg) return { ok: false, error: "svg_too_large" };
  return { ok: true, svg };
}

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** A start tag with its attributes (quoted values may hold ">"). */
const SVG_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
const SVG_ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** The text of each <style> element, CDATA or not. */
const SVG_STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** An attribute value as the browser reads it: XML's entities and character references decoded. */
function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9A-Fa-f]{1,6});/g, (_, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return "";
      }
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e as "amp"];
  });
}

/** A link target inside the picture: "#an-id", or an embedded raster image. */
const LOCAL_TARGET = /^\s*(?:#|data:image\/(?:png|jpeg|gif|webp)[;,])/i;
/** CSS that reaches outside: a url(…) that isn't "#an-id", or an @import. */
const CSS_EXTERNAL = [/url\((?!\s*["']?\s*#)/i, /@import/i];

/**
 * Whether SVG code reaches outside itself: an href / xlink:href / src whose value isn't "#an-id" or an embedded raster
 * image, or CSS (a style attribute, a presentation attribute such as fill, a <style> element) with a url(…) that isn't
 * "#an-id" or an @import. Only attribute values and <style> text count, decoded, so a picture whose visible text says
 * "url()" is fine. Browsers don't fetch any of this for an SVG shown in an <img>, but a course cover is meant to be
 * self-contained, so the cover check refuses it (checkCoverSvg).
 */
function svgReachesOut(svg: string): boolean {
  for (const tag of svg.matchAll(SVG_TAG)) {
    for (const [, name, dq, sq] of (tag[2] ?? "").matchAll(SVG_ATTRIBUTE)) {
      const value = decodeXml(dq ?? sq ?? "");
      const local = name!.toLowerCase().replace(/^[^:]*:/, "");
      if ((local === "href" || local === "src") && !LOCAL_TARGET.test(value)) return true;
      if (CSS_EXTERNAL.some((re) => re.test(value))) return true;
    }
  }
  for (const [, css] of svg.matchAll(SVG_STYLE)) {
    if (CSS_EXTERNAL.some((re) => re.test(decodeXml(css ?? "")))) return true;
  }
  return false;
}

/**
 * The namespace prefixes used in element and attribute names (other than xml and xmlns) that the code never
 * declares. A browser shows nothing for an SVG image with one: SVG copied out of an HTML page often uses xlink:href
 * without declaring xlink, since HTML doesn't need it.
 */
function undeclaredPrefixes(svg: string): Set<string> {
  const used = new Set<string>();
  const declared = new Set<string>();
  for (const tag of svg.matchAll(SVG_TAG)) {
    const el = /^([^:]+):/.exec(tag[1]!);
    if (el) used.add(el[1]!);
    for (const [, name] of (tag[2] ?? "").matchAll(SVG_ATTRIBUTE)) {
      const m = /^([^:]+):(.+)$/.exec(name!);
      if (!m) continue;
      if (m[1] === "xmlns") declared.add(m[2]!);
      else used.add(m[1]!);
    }
  }
  for (const p of declared) used.delete(p);
  used.delete("xml");
  return used;
}

/**
 * checkSvg, then the stricter rules for a course cover: line endings as a form submits them (so the live check in the
 * studio and the server count the same characters), an undeclared xlink prefix declared on the root (any other
 * undeclared prefix is invalid), and no references to other files (svgReachesOut).
 */
export function checkCoverSvg(
  raw: unknown,
): { ok: true; svg: string } | { ok: false; error: "svg_invalid" | "svg_too_large" | "svg_unsafe" | "svg_external" } {
  const r = checkSvg(typeof raw === "string" ? raw.replace(/\r\n?/g, "\n") : raw);
  if (!r.ok) return r;
  let svg = r.svg;
  const missing = undeclaredPrefixes(svg);
  if (missing.delete("xlink")) {
    const at = svgRootStart(svg);
    svg = `${svg.slice(0, at)}<svg xmlns:xlink="${XLINK_NAMESPACE}"${svg.slice(at + 4)}`;
    if (svg.length > MEDIA_LIMITS.svg) return { ok: false, error: "svg_too_large" };
  }
  if (missing.size) return { ok: false, error: "svg_invalid" };
  return svgReachesOut(svg) ? { ok: false, error: "svg_external" } : { ok: true, svg };
}

/** Where an attribute's value sits in the code (between its quotes). */
type ValueSpan = { from: number; to: number };

const XML_NAME_START = /[A-Za-z_:]/;
const XML_NAME_CHAR = /[A-Za-z0-9_:.-]/;
const XML_SPACE = (c: string | undefined) => c === " " || c === "\n" || c === "\r" || c === "\t";
const XML_ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9A-Fa-f]{1,6});/;

/** Whether every `&` in `text` starts one of XML's own entities or a character reference (no other is defined). */
function entitiesOk(text: string): boolean {
  for (let i = text.indexOf("&"); i >= 0; i = text.indexOf("&", i + 1)) {
    if (!XML_ENTITY.test(text.slice(i, i + 12))) return false;
  }
  return true;
}

/**
 * Check that the document from `start` (where the root `<svg` begins) to the end is exactly one well-formed XML
 * element: matched and properly nested tags, quoted attribute values without `<`, no duplicate attribute on a tag,
 * only XML's own entities, and comments, CDATA and processing instructions closed. One forward pass with a stack of
 * open tag names, so it is linear in the input. Returns the root's attributes (where each value sits), or null.
 */
function scanSvgElement(svg: string, start: number): { attributes: Map<string, ValueSpan> } | null {
  const open: string[] = [];
  let rootAttributes: Map<string, ValueSpan> | null = null;
  let i = start;
  const n = svg.length;
  const readName = (): string | null => {
    if (!XML_NAME_START.test(svg[i] ?? "")) return null;
    const from = i;
    while (i < n && XML_NAME_CHAR.test(svg[i]!)) i++;
    return svg.slice(from, i);
  };
  while (i < n) {
    if (open.length === 0 && rootAttributes) return null; // something after the root closed
    const lt = svg.indexOf("<", i);
    if (lt < 0) return null; // text after the last tag, with the root still open
    if (open.length > 0 && !entitiesOk(svg.slice(i, lt))) return null;
    if (open.length === 0 && lt !== i) return null;
    i = lt;
    if (svg.startsWith("<!--", i)) {
      const end = svg.indexOf("-->", i + 4);
      if (end < 0 || open.length === 0) return null;
      i = end + 3;
    } else if (svg.startsWith("<![CDATA[", i)) {
      const end = svg.indexOf("]]>", i + 9);
      if (end < 0 || open.length === 0) return null;
      i = end + 3;
    } else if (svg.startsWith("<?", i)) {
      const end = svg.indexOf("?>", i + 2);
      if (end < 0 || open.length === 0) return null;
      i = end + 2;
    } else if (svg.startsWith("</", i)) {
      i += 2;
      const name = readName();
      while (XML_SPACE(svg[i])) i++;
      if (!name || svg[i] !== ">" || open.pop() !== name) return null;
      i++;
    } else if (svg[i + 1] === "!") {
      return null; // a doctype or declaration inside the document
    } else {
      i++;
      const name = readName();
      if (!name || (open.length === 0 && rootAttributes) || (!rootAttributes && name !== "svg")) return null;
      const attributes = new Map<string, ValueSpan>();
      for (;;) {
        const before = i;
        while (XML_SPACE(svg[i])) i++;
        if (svg[i] === ">" || svg.startsWith("/>", i)) break;
        if (i === before) return null; // attributes must be separated by space
        const attr = readName();
        if (!attr || attributes.has(attr)) return null;
        while (XML_SPACE(svg[i])) i++;
        if (svg[i] !== "=") return null;
        i++;
        while (XML_SPACE(svg[i])) i++;
        const quote = svg[i];
        if (quote !== '"' && quote !== "'") return null;
        const end = svg.indexOf(quote, i + 1);
        if (end < 0) return null;
        const value = svg.slice(i + 1, end);
        if (value.includes("<") || !entitiesOk(value)) return null;
        attributes.set(attr, { from: i + 1, to: end });
        i = end + 1;
      }
      if (!rootAttributes) rootAttributes = attributes;
      if (svg[i] === ">") {
        open.push(name);
        i++;
      } else i += 2; // "/>": an element with no content
    }
  }
  return open.length === 0 && rootAttributes ? { attributes: rootAttributes } : null;
}

/** How stored SVG code is shown: as a data: URL in an <img>, never as markup in the page. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
