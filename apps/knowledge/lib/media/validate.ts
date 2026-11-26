/**
 * What may be uploaded and embedded (#359). Pure functions, shared by the server and the editor.
 *
 * Uploads: a short list of types, each with a size limit, and the file's first bytes must match the type it claims
 * (checked on the server after the upload, before the asset can be used). No SVG or HTML: both can carry script.
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

export const MEDIA_LIMITS = { filename: 200, alt: 300, caption: 300, label: 200, videoTitle: 200 } as const;

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
