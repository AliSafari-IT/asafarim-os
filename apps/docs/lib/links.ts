/**
 * Where a link or image inside a document goes (#80). Relative links resolve against the open
 * document's folder and must stay inside the listing: a link to another document opens in the app,
 * an image is served by /api/files (the gate runs first), and anything else relative, or a path
 * that climbs past the root, isn't a link at all.
 */

export type LinkTarget =
  | { kind: "doc"; path: string; hash: string }
  | { kind: "image"; path: string }
  | { kind: "hash"; hash: string }
  | { kind: "external"; href: string }
  | { kind: "none" };

const EXTERNAL = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `a/b/c.md` + `../d.md` → `a/d.md`; null when it climbs past the root. */
export function resolvePath(fromDoc: string, rel: string): string | null {
  const parts = rel.startsWith("/") ? [] : fromDoc.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

function decode(s: string): string | null {
  try {
    return decodeURI(s);
  } catch {
    return null;
  }
}

/**
 * What `href` (as written in `fromDoc`) points to. `paths` is the current listing: documents and
 * images that can actually be opened.
 */
export function resolveLink(
  fromDoc: string,
  href: string | undefined,
  paths: { docs: ReadonlySet<string>; images: ReadonlySet<string> },
): LinkTarget {
  if (!href) return { kind: "none" };
  if (href.startsWith("#")) return href.length > 1 ? { kind: "hash", hash: href } : { kind: "none" };
  if (EXTERNAL.test(href)) return { kind: "external", href };
  // javascript:, data:, protocol-relative //host… : never a link.
  if (SCHEME.test(href) || href.startsWith("//")) return { kind: "none" };
  const [rawPath = "", ...rest] = href.split("#");
  const hash = rest.length ? `#${rest.join("#")}` : "";
  const decoded = decode(rawPath.split("?")[0]!);
  if (decoded === null) return { kind: "none" };
  const target = resolvePath(fromDoc, decoded);
  if (!target) return { kind: "none" };
  if (paths.docs.has(target)) return { kind: "doc", path: target, hash };
  if (paths.images.has(target)) return { kind: "image", path: target };
  return { kind: "none" };
}

/** The app URL of a document. */
export const docHref = (p: string, hash = "") => `/?doc=${encodeURIComponent(p)}${hash}`;

/** The app URL of an image (served after the gate). */
export const fileHref = (p: string) => `/api/files/${p.split("/").map(encodeURIComponent).join("/")}`;
