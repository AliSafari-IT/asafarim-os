/**
 * The RSS feed (RSS 2.0 with the Atom self link and Dublin Core creator): the newest published articles, title and
 * summary only, so a reader's feed app links back to the article. Pure: the route (app/feed.xml/route.ts) supplies
 * the articles and the public address.
 *
 * Everything in it is an author's text, so nothing is trusted: characters XML 1.0 forbids are dropped (one of them in
 * a title would make every subscriber's reader reject the whole feed) and the five markup characters are escaped.
 */
import { createHash } from "node:crypto";

export interface FeedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date;
  author: string | null;
  category: string | null;
}

export interface FeedInput {
  /** The channel's own address, shown as the feed's "self" link. */
  selfUrl: string;
  /** The site the feed is for. */
  siteUrl: string;
  title: string;
  description: string;
  items: FeedItem[];
}

/** Keep only what XML 1.0 allows: tab, line feed, carriage return, and the ranges of real characters. */
function stripInvalidXml(s: string): string {
  let out = "";
  for (const ch of s) {
    // Iterating a string yields whole code points; a lone surrogate comes through alone and is dropped below.
    const c = ch.codePointAt(0)!;
    const ok =
      c === 0x9 ||
      c === 0xa ||
      c === 0xd ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      (c >= 0x10000 && c <= 0x10ffff);
    if (ok) out += ch;
  }
  return out;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Text safe to put in an XML element or attribute. */
export function xmlEscape(s: string): string {
  return stripInvalidXml(s).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** The start of an article's text, for an item whose author wrote no summary: whole words, about `max` characters. */
export function excerpt(text: string, max = 280): string {
  const flat = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const tag = (name: string, value: string) => `<${name}>${xmlEscape(value)}</${name}>`;

function renderItem(item: FeedItem): string {
  return [
    "    <item>",
    `      ${tag("title", item.title)}`,
    `      ${tag("link", item.url)}`,
    `      <guid isPermaLink="true">${xmlEscape(item.url)}</guid>`,
    // toUTCString is RFC 822 / RFC 1123 ("Fri, 27 Nov 2026 09:00:00 GMT"), the date format RSS 2.0 asks for.
    `      <pubDate>${item.publishedAt.toUTCString()}</pubDate>`,
    ...(item.author ? [`      ${tag("dc:creator", item.author)}`] : []),
    ...(item.category ? [`      ${tag("category", item.category)}`] : []),
    `      ${tag("description", item.summary)}`,
    "    </item>",
  ].join("\n");
}

export function renderFeed(input: FeedInput): string {
  // The newest item's date, not "now": the same articles give the same bytes, so the ETag is stable.
  const last = input.items.reduce<Date | null>((a, i) => (!a || i.publishedAt > a ? i.publishedAt : a), null);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "  <channel>",
    `    ${tag("title", input.title)}`,
    `    ${tag("link", input.siteUrl)}`,
    `    ${tag("description", input.description)}`,
    "    <language>en</language>",
    ...(last ? [`    <lastBuildDate>${last.toUTCString()}</lastBuildDate>`] : []),
    `    <atom:link href="${xmlEscape(input.selfUrl)}" rel="self" type="application/rss+xml"/>`,
    "    <generator>ASafariM Knowledge</generator>",
    ...input.items.map(renderItem),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

/**
 * The feed's `<link rel="alternate">` for a page's metadata. A page that sets its own `alternates` (a canonical
 * address) REPLACES the layout's, not adds to it, so every such page must include this too: the layout and each page
 * that sets `alternates` spread it in (test/feed.test.ts keeps that true).
 */
export const feedAlternates = () => ({
  "application/rss+xml": [{ url: "/feed.xml", title: "ASafariM Knowledge" }],
});

/** A strong validator for the rendered feed: readers and caches send it back as If-None-Match. */
export const etagOf = (body: string): string => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

/** Does an If-None-Match header (a list, possibly weak validators, possibly "*") match this ETag? */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((v) => v.trim().replace(/^W\//, "") === etag);
}
