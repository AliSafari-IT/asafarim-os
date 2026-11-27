import type { TagLink } from "@asafarim/tags";
import { isTagSlug } from "@asafarim/tags";
import type pg from "pg";

/** Projection for a public article query whose content_items alias is i. */
export const ARTICLE_TAGS_SQL = `(SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'slug', t.slug)
  ORDER BY t.name, t.slug), '[]'::jsonb)
  FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id)`;

export async function publicTag(pool: Pick<pg.Pool, "query">, slug: string) {
  if (!isTagSlug(slug)) return null;
  const { rows } = await pool.query<TagLink>(
    `SELECT t.slug, t.name FROM tags t WHERE t.slug = $1
     AND EXISTS (SELECT 1 FROM search_documents d WHERE d.tag_ids @> ARRAY[t.id])`,
    [slug],
  );
  return rows[0] ?? null;
}
