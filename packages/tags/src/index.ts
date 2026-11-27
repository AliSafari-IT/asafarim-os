import { randomUUID } from "node:crypto";
import type pg from "pg";

type Client = Pick<pg.PoolClient, "query">;
export const TAG_LIMITS = { slug: 64, tagName: 60, alias: 60 } as const;
export const isTagSlug = (s: string) => s.length <= TAG_LIMITS.slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
export interface TagLink {
  slug: string;
  name: string;
}
export interface Tag<K extends string = string> extends TagLink {
  id: string;
  kind: K;
  aliases: string[];
}
export async function listTags<K extends string>(pool: Client): Promise<Tag<K>[]> {
  const { rows } = await pool.query<{ id: string; slug: string; name: string; kind: K; aliases: string[] }>(
    `SELECT t.id, t.slug, t.name, t.kind, coalesce(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS aliases
     FROM tags t LEFT JOIN tag_aliases a ON a.tag_id = t.id GROUP BY t.id ORDER BY t.name, t.slug`,
  );
  return rows;
}

/** Lower-case and trimmed, or null when it isn't a usable alias. */
const aliasOf = (raw: string) => {
  const a = raw.trim().toLowerCase();
  return a && a.length <= TAG_LIMITS.alias ? a : null;
};

/** Call inside the host app’s transaction after checking its permissions and allowed kinds. */
export async function insertTag(
  c: Client,
  input: { slug: string; name: string; kind: string; aliases?: string[] },
  lockName = "asafarim.tags",
) {
  const name = input.name.trim();
  if (!isTagSlug(input.slug)) return { ok: false, error: "invalid_slug" } as const;
  if (!name || name.length > TAG_LIMITS.tagName) return { ok: false, error: "invalid_name" } as const;
  const entered = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const tooLong = entered.find((a) => !aliasOf(a));
  if (tooLong) return { ok: false, error: "invalid_alias", detail: tooLong } as const;
  const aliases = [...new Set(entered.map((a) => aliasOf(a)!))].filter((a) => a !== input.slug);

  // One lock for every tag name, so a slug and an alias can't be claimed at once by two tags.
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockName]);
  const clash = await c.query<{ name: string }>(
    `SELECT slug AS name FROM tags WHERE slug = ANY($1::text[])
       UNION SELECT alias FROM tag_aliases WHERE alias = ANY($1::text[])`,
    [[input.slug, ...aliases]],
  );
  if (clash.rows.some((r) => r.name === input.slug)) return { ok: false, error: "slug_taken" } as const;
  if (clash.rowCount) return { ok: false, error: "alias_taken", detail: clash.rows[0]!.name } as const;
  const id = randomUUID();
  await c.query("INSERT INTO tags (id, slug, name, kind) VALUES ($1,$2,$3,$4)", [id, input.slug, name, input.kind]);
  if (aliases.length) {
    await c.query("INSERT INTO tag_aliases (alias, tag_id) SELECT a, $2 FROM unnest($1::text[]) AS a", [aliases, id]);
  }
  return { ok: true, id } as const;
}

/** Tag ids for what an author typed (slugs, names or aliases, case-insensitive); the first unknown one is reported. */
export async function resolveTags(
  pool: Client,
  names: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: "unknown_tag" | "ambiguous_tag"; key: string }> {
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return { ok: true, ids: [] };
  // Each word names exactly one tag: a slug or an alias first (both unique), else a display name only when one tag
  // has it (names may repeat across kinds, e.g. a subject and a technology both called "Go").
  const { rows } = await pool.query<{ key: string; id: string | null; names: number }>(
    `SELECT w AS key,
            coalesce((SELECT id FROM tags WHERE slug = w), (SELECT tag_id FROM tag_aliases WHERE alias = w),
                     (SELECT min(id) FROM tags WHERE lower(name) = w HAVING count(*) = 1)) AS id,
            (SELECT count(*)::int FROM tags WHERE lower(name) = w) AS names
     FROM unnest($1::text[]) AS w`,
    [wanted],
  );
  for (const r of rows) {
    if (!r.id) return { ok: false, error: r.names > 1 ? "ambiguous_tag" : "unknown_tag", key: r.key };
  }
  return { ok: true, ids: [...new Set(rows.map((r) => r.id!))] };
}
