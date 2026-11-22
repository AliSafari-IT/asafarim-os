/**
 * The public search projection (#357). `refreshSearchDocument` rewrites one article's rows from its PUBLISHED
 * revision, or deletes them when nothing is published; lib/content.ts and lib/taxonomy.ts call it inside the
 * transaction that publishes, withdraws, moves or reclassifies the article, so the projection can never show a
 * draft, or a withdrawn article, even for a moment. `buildProjection` is pure: what is indexed from a revision.
 */
import type pg from "pg";
import { headingIds, type Doc, type DocNode } from "./doc";
import { allTokens, codeTokens, uniqueTerms } from "./identifiers";

type Client = Pick<pg.PoolClient, "query">;

export interface Section {
  /** The heading's id on the public page (DocView), or null before the first heading / for Markdown. */
  anchor: string | null;
  heading: string;
  body: string;
}

export interface Projection {
  sections: Section[];
  headings: string;
  body: string;
  terms: string[];
}

/** Sections stay below this, so one huge article can't make the projection huge. */
const SECTION_LIMIT = 200;

function textOf(n: DocNode, acc: string[], code: string[]): void {
  if (n.type === "text") {
    acc.push(n.text ?? "");
    if (n.marks?.some((m) => m.type === "code")) code.push(n.text ?? "");
    return;
  }
  if (n.type === "hardBreak") acc.push("\n");
  if (n.type === "mermaid") {
    acc.push(String(n.attrs?.description ?? ""));
    return;
  }
  for (const c of n.content ?? []) textOf(c, acc, code);
}

function fromDoc(doc: Doc): { sections: Section[]; code: string[] } {
  const ids = headingIds(doc);
  const sections: Section[] = [{ anchor: null, heading: "", body: "" }];
  const code: string[] = [];
  const lines: string[][] = [[]];
  for (const block of doc.content ?? []) {
    if (block.type === "heading") {
      const parts: string[] = [];
      textOf(block, parts, code);
      sections.push({ anchor: ids.get(block) ?? null, heading: parts.join("").trim(), body: "" });
      lines.push([]);
      continue;
    }
    const parts: string[] = [];
    const blockCode: string[] = [];
    textOf(block, parts, blockCode);
    if (block.type === "codeBlock") code.push(parts.join(""));
    else code.push(...blockCode);
    lines.at(-1)!.push(parts.join("").trim());
  }
  sections.forEach((s, i) => (s.body = lines[i]!.filter(Boolean).join("\n")));
  return { sections, code };
}

function fromMarkdown(markdown: string): { sections: Section[]; code: string[] } {
  const sections: Section[] = [{ anchor: null, heading: "", body: "" }];
  const code: string[] = [];
  const body: string[][] = [[]];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      code.push(line);
      body.at(-1)!.push(line);
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      sections.push({ anchor: null, heading: h[1]!.trim(), body: "" });
      body.push([]);
      continue;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) code.push(m[1]!);
    body.at(-1)!.push(line);
  }
  sections.forEach((s, i) => (s.body = body[i]!.join("\n").trim()));
  return { sections, code };
}

/** What a published revision contributes to search. */
export function buildProjection(revision: {
  format: "markdown" | "tiptap";
  doc: Doc | null;
  title: string;
  summary: string;
  body: string;
}): Projection {
  const { sections: all, code } =
    revision.format === "tiptap" && revision.doc ? fromDoc(revision.doc) : fromMarkdown(revision.body);
  const sections = all.filter((s, i) => i === 0 || s.heading || s.body).slice(0, SECTION_LIMIT);
  if (!sections[0]!.body && sections.length > 1) sections.shift();
  const body = sections.map((s) => s.body).join("\n");
  const headings = sections.map((s) => s.heading).join("\n");
  const terms = uniqueTerms(
    codeTokens(revision.title),
    code.flatMap(allTokens),
    codeTokens(headings),
    codeTokens(revision.summary),
    codeTokens(body),
  );
  return { sections, headings, body, terms };
}

interface Source {
  id: string;
  slug: string;
  kind: string;
  language: string;
  topic_id: string | null;
  level: string | null;
  published_revision_id: string | null;
  published_at: Date | null;
  format: "markdown" | "tiptap" | null;
  doc: Doc | null;
  title: string | null;
  summary: string | null;
  body: string | null;
  tag_ids: string[];
  tag_text: string;
}

/**
 * Rewrite one article's projection from its published revision, or remove it. Call inside the transaction that
 * changed the article, after the change, with the item row already locked.
 */
export async function refreshSearchDocument(c: Client, itemId: string): Promise<void> {
  const src = (
    await c.query<Source>(
      `SELECT i.id, i.slug, i.kind, i.language, i.topic_id, i.level, i.published_revision_id, i.published_at,
              r.format, r.doc, r.title, r.summary, r.body,
              coalesce(array_agg(t.id ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}') AS tag_ids,
              coalesce(string_agg(t.name || ' ' || t.slug, ' '), '') AS tag_text
       FROM content_items i
       LEFT JOIN content_revisions r ON r.id = i.published_revision_id AND r.item_id = i.id
       LEFT JOIN item_tags it ON it.item_id = i.id
       LEFT JOIN tags t ON t.id = it.tag_id
       WHERE i.id = $1
       GROUP BY i.id, r.id`,
      [itemId],
    )
  ).rows[0];
  await c.query("DELETE FROM search_documents WHERE item_id = $1", [itemId]);
  if (!src?.published_revision_id || !src.format || src.title === null) return;

  const p = buildProjection({
    format: src.format,
    doc: src.doc,
    title: src.title,
    summary: src.summary ?? "",
    body: src.body ?? "",
  });
  await c.query(
    `INSERT INTO search_documents (item_id, revision_id, slug, kind, language, topic_id, level, tag_ids, title, summary,
       published_at, tsv)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       setweight(to_tsvector('simple', $9), 'A') ||
       setweight(to_tsvector('simple', $12), 'B') ||
       setweight(to_tsvector('simple', $10), 'C') ||
       setweight(to_tsvector('simple', $13), 'D'))`,
    [
      src.id,
      src.published_revision_id,
      src.slug,
      src.kind,
      src.language,
      src.topic_id,
      src.level,
      src.tag_ids,
      src.title,
      src.summary ?? "",
      src.published_at,
      `${src.tag_text}\n${p.headings}`,
      p.body,
    ],
  );
  if (p.terms.length) {
    await c.query(
      "INSERT INTO search_terms (item_id, term) SELECT $1, t FROM unnest($2::text[]) AS t ON CONFLICT DO NOTHING",
      [src.id, p.terms],
    );
  }
  await c.query(
    `INSERT INTO search_sections (item_id, position, anchor, heading, body, tsv)
     SELECT $1, s.ord - 1, s.anchor, s.heading, s.body,
            setweight(to_tsvector('simple', s.heading), 'A') || to_tsvector('simple', s.body)
     FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS s (anchor, heading, body, ord)`,
    [src.id, p.sections.map((s) => s.anchor), p.sections.map((s) => s.heading), p.sections.map((s) => s.body)],
  );
}
