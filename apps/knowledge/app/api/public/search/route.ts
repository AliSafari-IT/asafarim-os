/**
 * GET /api/public/search?q=&topic=&tag=&technology=&level=&language=&kind=&after= (#357): published articles only
 * (it reads the search projection), JSON, cursor-paginated, rate limited per client (429 with Retry-After).
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { clientKey, searchLimiter } from "@/lib/rate-limit";
import { searchPublished, snippetParts } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limited = searchLimiter.take(clientKey(req.headers));
  if (!limited.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many searches. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }
  const p = req.nextUrl.searchParams;
  try {
    const page = await searchPublished(await db(), {
      q: p.get("q"),
      after: p.get("after"),
      filters: {
        topic: p.get("topic"),
        tag: p.get("tag"),
        technology: p.get("technology"),
        level: p.get("level"),
        language: p.get("language"),
        kind: p.get("kind"),
      },
    });
    return NextResponse.json(
      {
        items: page.items.map((h) => ({
          url: `/articles/${h.slug}`,
          slug: h.slug,
          title: h.title,
          summary: h.summary,
          publishedAt: h.publishedAt.toISOString(),
          level: h.level,
          topic: h.topic,
          snippet: snippetParts(h.snippet),
          section: h.section ? { heading: h.section.heading, url: `/articles/${h.slug}#${h.section.anchor}` } : null,
        })),
        next: page.next,
      },
      // Not cacheable: a withdrawn article must leave the results at once, for every reader.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "unavailable", message: "Search is unavailable right now." }, { status: 503 });
  }
}
