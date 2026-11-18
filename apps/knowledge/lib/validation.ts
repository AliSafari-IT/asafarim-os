import type { Doc } from "./doc";

/** What a draft may contain. The database checks the same limits; this gives a useful message first. */

export const LIMITS = { title: 200, summary: 500, body: 200_000, slug: 96 } as const;

export interface DraftInput {
  title: string;
  summary: string;
  /** The Markdown (Phase 0 revisions), or the document's plain text when `doc` is set. */
  body: string;
  /** A parsed structured document (lib/doc.ts); new revisions always have one. */
  doc?: Doc;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A URL slug from a title: lower-case ASCII words joined by dashes, accents folded, at most 96 characters. */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.slug)
    .replace(/-+$/g, "");
}

export function isSlug(s: string): boolean {
  return s.length > 0 && s.length <= LIMITS.slug && SLUG.test(s);
}

/** Line endings normalised, the title trimmed; everything else kept as the author wrote it. */
export function parseDraft(input: { title?: unknown; summary?: unknown; body?: unknown }): Parsed<DraftInput> {
  const text = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "");
  const title = text(input.title).trim();
  const summary = text(input.summary).trim();
  const body = text(input.body);
  if (!title) return { ok: false, error: "title_required" };
  if (title.length > LIMITS.title) return { ok: false, error: "title_too_long" };
  if (summary.length > LIMITS.summary) return { ok: false, error: "summary_too_long" };
  if (body.length > LIMITS.body) return { ok: false, error: "body_too_long" };
  return { ok: true, value: { title, summary, body } };
}

/** The slug an author asked for, or one made from the title when they left it empty. */
export function parseSlug(raw: unknown, title: string): Parsed<string> {
  const asked = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const slug = asked || slugify(title);
  if (!isSlug(slug)) return { ok: false, error: "invalid_slug" };
  return { ok: true, value: slug };
}
