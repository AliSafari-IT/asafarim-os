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
 * 100 000 characters, with no script, event handler, foreign HTML or entity declaration. Gains the SVG namespace when
 * it lacks one (an <img> shows nothing without it). Returns the code to store, or an error.
 */
export function checkSvg(
  raw: unknown,
): { ok: true; svg: string } | { ok: false; error: "svg_invalid" | "svg_too_large" | "svg_unsafe" } {
  if (typeof raw !== "string") return { ok: false, error: "svg_invalid" };
  let svg = raw.trim();
  if (svg.length > MEDIA_LIMITS.svg) return { ok: false, error: "svg_too_large" };
  if (svg.includes("\u0000")) return { ok: false, error: "svg_invalid" };
  const rootStart = svgRootStart(svg);
  // `svg` is trimmed, so the closing tag is at the very end.
  if (rootStart < 0 || !/<\/svg\s*>$/i.test(svg)) return { ok: false, error: "svg_invalid" };
  if (SVG_FORBIDDEN.some((re) => re.test(svg))) return { ok: false, error: "svg_unsafe" };
  // The root element: add the namespace if it is missing.
  const rootEnd = svg.indexOf(">", rootStart);
  if (rootEnd < 0) return { ok: false, error: "svg_invalid" };
  const rootTag = svg.slice(rootStart, rootEnd);
  if (!/\sxmlns\s*=/.test(rootTag)) {
    svg = `${svg.slice(0, rootStart)}<svg xmlns="http://www.w3.org/2000/svg"${svg.slice(rootStart + 4)}`;
  }
  return { ok: true, svg };
}

/** How stored SVG code is shown: as a data: URL in an <img>, never as markup in the page. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
