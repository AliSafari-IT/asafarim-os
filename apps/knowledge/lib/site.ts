/**
 * Where this app lives on the public web. Share links, canonical links and Open Graph tags all use this one fixed
 * address, never the request's Host header: a link in a page must not depend on what a visitor sent, and a shared
 * link must always point at the real site whichever address was used to reach it.
 *
 * KNOWLEDGE_PUBLIC_ORIGIN overrides it (local development: http://localhost:4140). Anything that isn't a plain
 * http(s) origin is ignored.
 */
import manifest from "../platform.app";

/** Only if the manifest declares no primary domain, which this app's always has. */
const LAST_RESORT_HOST = "learn.asafarim.site";

export function publicOrigin(env: Record<string, string | undefined> = process.env): string {
  const override = env.KNOWLEDGE_PUBLIC_ORIGIN?.trim();
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // not a URL: fall through to the real address
    }
  }
  return `https://${manifest.domains?.primary ?? LAST_RESORT_HOST}`;
}

/** The public address of a published article. */
export function articleUrl(slug: string, origin: string = publicOrigin()): string {
  return `${origin}/articles/${slug}`;
}
