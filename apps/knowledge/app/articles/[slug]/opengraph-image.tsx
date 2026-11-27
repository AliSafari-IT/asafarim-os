/**
 * The picture LinkedIn, X and messaging apps show with a shared article (Open Graph / Twitter card): the title and
 * author on the site's colours, 1200×630. Made only from a published article; anything else gets the site's own card.
 */
import { ImageResponse } from "next/og";
import { getPublishedArticle } from "@/lib/content";
import { db } from "@/lib/db";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const alt = "ASafariM Knowledge article";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = isSlug(slug) ? await getPublishedArticle(await db(), slug).catch(() => null) : null;
  const title = clip(article?.title ?? "Write, learn, and share technical knowledge.", 110);
  const byline = article ? (article.authorName ?? "ASafariM Knowledge") : "ASafariM Knowledge";
  // Shorter titles get bigger type.
  const fontSize = title.length > 80 ? 56 : title.length > 50 ? 68 : 82;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background: "linear-gradient(135deg, #14506f 0%, #0b2e42 100%)",
        color: "#ffffff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", fontSize: 32, fontWeight: 700, opacity: 0.92 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 56,
            height: 56,
            borderRadius: 14,
            background: "#ffffff",
            color: "#14506f",
            fontSize: 36,
            marginRight: 20,
          }}
        >
          K
        </div>
        ASafariM Knowledge
      </div>
      <div style={{ display: "flex", fontSize, fontWeight: 800, lineHeight: 1.12, letterSpacing: -1 }}>{title}</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, opacity: 0.9 }}>
        <span>{article ? `By ${byline}` : "learn.asafarim.site"}</span>
        <span>learn.asafarim.site</span>
      </div>
    </div>,
    { ...size },
  );
}
