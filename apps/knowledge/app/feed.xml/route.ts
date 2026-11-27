/**
 * The RSS feed of the newest published articles, for anyone (a public path in platform.app.ts). It reads only what
 * listPublished can read: published revisions. Short-lived caching plus an ETag, so feed readers polling every few
 * minutes get a 304 and no body.
 */
import { listPublished } from "@/lib/content";
import { db } from "@/lib/db";
import { etagOf, excerpt, matchesEtag, renderFeed, type FeedItem } from "@/lib/feed";
import { articleUrl, publicOrigin } from "@/lib/site";

export const dynamic = "force-dynamic";

/** How many of the newest articles the feed carries. */
const LIMIT = 30;

const HEADERS = {
  "Content-Type": "application/rss+xml; charset=utf-8",
  "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(request: Request): Promise<Response> {
  let articles;
  try {
    articles = (await listPublished(await db(), { limit: LIMIT })).items;
  } catch {
    // Not a feed with no articles in it (a reader would think everything was deleted): an error, to try again.
    return new Response("The feed is unavailable right now.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }

  const origin = publicOrigin();
  const items: FeedItem[] = articles.map((a) => ({
    title: a.title,
    url: articleUrl(a.slug, origin),
    summary: a.summary || excerpt(a.body),
    publishedAt: a.publishedAt,
    author: a.authorName,
    category: a.topic?.name ?? null,
  }));
  const body = renderFeed({
    selfUrl: `${origin}/feed.xml`,
    siteUrl: `${origin}/`,
    title: "ASafariM Knowledge",
    description: "Write, learn, and share technical knowledge.",
    items,
  });

  const etag = etagOf(body);
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": HEADERS["Cache-Control"] } });
  }
  return new Response(body, { headers: { ...HEADERS, ETag: etag } });
}
