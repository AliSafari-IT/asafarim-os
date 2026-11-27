/**
 * Topics, curated tags and an article's classification (#357). Topics form a small hierarchy (top level and one
 * level below). Tags are curated: only someone with knowledge.taxonomy.manage creates them, with aliases (js ->
 * javascript); authors choose from them by slug, name or alias, and an unknown tag is refused rather than created.
 * Classifying a published article updates its search projection in the same transaction.
 */
import { randomUUID } from "node:crypto";
import {
  insertTag,
  listTags as listCatalogTags,
  resolveTags,
  TAG_LIMITS,
  isTagSlug,
  type Tag as CatalogTag,
} from "@asafarim/tags";
export { resolveTags };
import type pg from "pg";
import { canEdit, canManageTaxonomy, canPublish, canView, type Actor } from "./policy";
import { refreshSearchDocument } from "./search-index";

type Pool = Pick<pg.Pool, "connect" | "query">;
type Client = Pick<pg.PoolClient, "query">;

export const LEVELS = ["beginner", "intermediate", "advanced"] as const;
export type Level = (typeof LEVELS)[number];
export const TAG_KINDS = ["subject", "technology"] as const;
/** The languages an article can be written in (the platform's locales), with the name readers see. */
export const LANGUAGES = {
  en: "English",
  nl: "Nederlands",
  fr: "Français",
  de: "Deutsch",
  lb: "Lëtzebuergesch",
} as const;
export type Language = keyof typeof LANGUAGES;
export const isLanguage = (s: string): s is Language => Object.hasOwn(LANGUAGES, s);
export type TagKind = (typeof TAG_KINDS)[number];
export const TAXONOMY_LIMITS = { ...TAG_LIMITS, topicName: 80, description: 300, tagsPerItem: 12 };

export const isTaxonomySlug = isTagSlug;

export interface Topic {
  id: string;
  slug: string;
  name: string;
  description: string;
  parentId: string | null;
}

export type Tag = CatalogTag<TagKind>;

export interface Classification {
  topicId: string | null;
  level: Level | null;
  language: string;
  tags: Tag[];
}

export type TaxonomyResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      error:
        | "forbidden"
        | "not_found"
        | "invalid_slug"
        | "invalid_name"
        | "slug_taken"
        | "unknown_topic"
        | "topic_too_deep"
        | "unknown_tag"
        | "alias_taken"
        | "invalid_alias"
        | "too_many_tags"
        | "ambiguous_tag"
        | "invalid_level"
        | "invalid_language";
      detail?: string;
    };

async function inTransaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const toTopic = (r: { id: string; slug: string; name: string; description: string; parent_id: string | null }) => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  parentId: r.parent_id,
});

export async function listTopics(pool: Pick<Pool, "query">): Promise<Topic[]> {
  const { rows } = await pool.query("SELECT * FROM topics ORDER BY name, slug");
  return rows.map(toTopic);
}

export async function getTopic(pool: Pick<Pool, "query">, slug: string): Promise<Topic | null> {
  if (!isTaxonomySlug(slug)) return null;
  const row = (await pool.query("SELECT * FROM topics WHERE slug = $1", [slug])).rows[0];
  return row ? toTopic(row) : null;
}

export const listTags = (pool: Client) => listCatalogTags<TagKind>(pool);

export async function createTopic(
  pool: Pool,
  actor: Actor,
  input: { slug: string; name: string; description?: string; parentSlug?: string | null },
): Promise<TaxonomyResult<{ id: string }>> {
  if (!canManageTaxonomy(actor)) return { ok: false, error: "forbidden" };
  const name = input.name.trim();
  if (!isTaxonomySlug(input.slug)) return { ok: false, error: "invalid_slug" };
  if (!name || name.length > TAXONOMY_LIMITS.topicName) return { ok: false, error: "invalid_name" };
  const description = (input.description ?? "").trim().slice(0, TAXONOMY_LIMITS.description);
  return inTransaction(pool, async (c) => {
    let parentId: string | null = null;
    if (input.parentSlug) {
      const parent = (
        await c.query<{ id: string; parent_id: string | null }>(
          "SELECT id, parent_id FROM topics WHERE slug = $1 FOR SHARE",
          [input.parentSlug],
        )
      ).rows[0];
      if (!parent) return { ok: false, error: "unknown_topic" } as const;
      if (parent.parent_id) return { ok: false, error: "topic_too_deep" } as const;
      parentId = parent.id;
    }
    const id = randomUUID();
    const r = await c.query(
      "INSERT INTO topics (id, slug, name, description, parent_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING",
      [id, input.slug, name, description, parentId],
    );
    if (r.rowCount === 0) return { ok: false, error: "slug_taken" } as const;
    return { ok: true, id } as const;
  });
}

export async function createTag(
  pool: Pool,
  actor: Actor,
  input: { slug: string; name: string; kind: TagKind; aliases?: string[] },
): Promise<TaxonomyResult<{ id: string }>> {
  if (!canManageTaxonomy(actor)) return { ok: false, error: "forbidden" };
  if (!(TAG_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "invalid_name" };
  return inTransaction(pool, (c) => insertTag(c, input, "knowledge.tags"));
}

export async function getClassification(pool: Pick<Pool, "query">, itemId: string): Promise<Classification> {
  const item = (
    await pool.query<{ topic_id: string | null; level: Level | null; language: string }>(
      "SELECT topic_id, level, language FROM content_items WHERE id = $1",
      [itemId],
    )
  ).rows[0];
  const { rows } = await pool.query<Tag>(
    `SELECT t.id, t.slug, t.name, t.kind, '{}'::text[] AS aliases FROM item_tags it JOIN tags t ON t.id = it.tag_id
     WHERE it.item_id = $1 ORDER BY t.name`,
    [itemId],
  );
  return { topicId: item?.topic_id ?? null, level: item?.level ?? null, language: item?.language ?? "en", tags: rows };
}

/**
 * Set an article's topic, level and tags. Like its address, once the article has been public its classification
 * is public too (facets, topic pages), so changing it then needs the publish permission; a draft needs edit.
 */
export async function classify(
  pool: Pool,
  actor: Actor,
  input: { id: string; topicSlug: string | null; level: string | null; tags: string[]; language?: string },
): Promise<TaxonomyResult<object>> {
  if (input.level !== null && !(LEVELS as readonly string[]).includes(input.level)) {
    return { ok: false, error: "invalid_level" };
  }
  if (input.language !== undefined && !isLanguage(input.language)) return { ok: false, error: "invalid_language" };
  if (input.tags.length > TAXONOMY_LIMITS.tagsPerItem) return { ok: false, error: "too_many_tags" };
  const tags = await resolveTags(pool, input.tags);
  if (!tags.ok) return { ok: false, error: tags.error, detail: tags.key };
  if (tags.ids.length > TAXONOMY_LIMITS.tagsPerItem) return { ok: false, error: "too_many_tags" };
  return inTransaction(pool, async (c) => {
    const item = (
      await c.query<{
        id: string;
        owner_subject: string;
        published_revision_id: string | null;
        withdrawn_at: Date | null;
      }>("SELECT id, owner_subject, published_revision_id, withdrawn_at FROM content_items WHERE id = $1 FOR UPDATE", [
        input.id,
      ])
    ).rows[0];
    const owner = { ownerSubject: item?.owner_subject ?? "" };
    if (!item || !canView(actor, owner)) return { ok: false, error: "not_found" } as const;
    const wasPublic = item.published_revision_id !== null || item.withdrawn_at !== null;
    if (!(wasPublic ? canPublish(actor, owner) : canEdit(actor, owner)))
      return { ok: false, error: "forbidden" } as const;
    let topicId: string | null = null;
    if (input.topicSlug) {
      topicId =
        (await c.query<{ id: string }>("SELECT id FROM topics WHERE slug = $1", [input.topicSlug])).rows[0]?.id ?? null;
      if (!topicId) return { ok: false, error: "unknown_topic" } as const;
    }
    await c.query(
      "UPDATE content_items SET topic_id = $2, level = $3, language = coalesce($4, language), updated_at = now() WHERE id = $1",
      [item.id, topicId, input.level, input.language ?? null],
    );
    await c.query("DELETE FROM item_tags WHERE item_id = $1", [item.id]);
    if (tags.ids.length) {
      await c.query("INSERT INTO item_tags (item_id, tag_id) SELECT $1, t FROM unnest($2::text[]) AS t", [
        item.id,
        tags.ids,
      ]);
    }
    await refreshSearchDocument(c, item.id);
    return { ok: true } as const;
  });
}
