// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { etagOf, excerpt, feedAlternates, matchesEtag, renderFeed, xmlEscape, type FeedItem } from "../lib/feed";

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  title: "Building AI-Powered Web Apps",
  url: "https://learn.asafarim.site/articles/ai-apps",
  summary: "From concept to deployment.",
  publishedAt: new Date("2026-11-26T09:00:00Z"),
  author: "Sara Janssens",
  category: "Web Development",
  ...over,
});

const feed = (items: FeedItem[]) =>
  renderFeed({
    selfUrl: "https://learn.asafarim.site/feed.xml",
    siteUrl: "https://learn.asafarim.site/",
    title: "ASafariM Knowledge",
    description: "Write, learn, and share technical knowledge.",
    items,
  });

/**
 * Parse as XML and fail on anything that is not well-formed, which is exactly what a feed reader would do.
 * (DOMParser doesn't throw: it returns a document holding a <parsererror>.)
 */
const parse = (xml: string): Document => {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const error = doc.getElementsByTagName("parsererror")[0];
  if (error) throw new Error(`not well-formed XML: ${error.textContent?.slice(0, 200)}`);
  return doc;
};

describe("the parser used below", () => {
  it("really does reject malformed XML (so a pass means something)", () => {
    expect(() => parse("<a><b></a>")).toThrow(/not well-formed/);
    expect(() => parse("<a>&nbsp;</a>")).toThrow(/not well-formed/); // an HTML entity XML doesn't define
    expect(() => parse(`<a>${String.fromCharCode(0)}</a>`)).toThrow(/not well-formed/);
    expect(() => parse("<a><b/></a>")).not.toThrow();
  });
});

describe("xmlEscape", () => {
  it("escapes the five markup characters", () => {
    expect(xmlEscape(`<a href="x">Q&A's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Q&amp;A&apos;s&lt;/a&gt;");
    expect(xmlEscape("]]>")).toBe("]]&gt;"); // can't close a CDATA section it isn't in, and can't be misread
  });

  it("drops what XML 1.0 forbids: control characters, a lone surrogate, U+FFFE and U+FFFF", () => {
    // Each on its own: two surrogates side by side would be a valid pair, not a lone one.
    for (const code of [0, 1, 8, 11, 12, 14, 31, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffe, 0xffff]) {
      expect(xmlEscape(`a${String.fromCharCode(code)}b`), `U+${code.toString(16)}`).toBe("ab");
    }
  });

  it("keeps a valid surrogate pair (an emoji is two UTF-16 units)", () => {
    expect(xmlEscape(`a${String.fromCharCode(0xd83d, 0xde00)}b`)).toBe("a\u{1F600}b");
  });

  it("keeps tab, newline, carriage return, accents, CJK and emoji", () => {
    const keep = `t${String.fromCharCode(9)}n${String.fromCharCode(10)}r${String.fromCharCode(13)} é 日本語 😀`;
    expect(xmlEscape(keep)).toBe(keep);
  });
});

describe("the feed", () => {
  it("is well-formed RSS 2.0 with the channel and item fields in place", () => {
    const doc = parse(feed([item(), item({ title: "Second", url: "https://learn.asafarim.site/articles/second" })]));
    const rss = doc.documentElement;
    expect(rss.tagName).toBe("rss");
    expect(rss.getAttribute("version")).toBe("2.0");
    const channel = rss.getElementsByTagName("channel")[0]!;
    const text = (parent: Element, name: string) => parent.getElementsByTagName(name)[0]?.textContent;
    expect(text(channel, "title")).toBe("ASafariM Knowledge");
    expect(text(channel, "link")).toBe("https://learn.asafarim.site/");
    expect(text(channel, "language")).toBe("en");
    expect(channel.getElementsByTagName("atom:link")[0]!.getAttribute("href")).toBe(
      "https://learn.asafarim.site/feed.xml",
    );
    const items = [...channel.getElementsByTagName("item")];
    expect(items).toHaveLength(2);
    expect(text(items[0]!, "title")).toBe("Building AI-Powered Web Apps");
    expect(text(items[0]!, "link")).toBe("https://learn.asafarim.site/articles/ai-apps");
    expect(items[0]!.getElementsByTagName("guid")[0]!.getAttribute("isPermaLink")).toBe("true");
    expect(text(items[0]!, "pubDate")).toBe("Thu, 26 Nov 2026 09:00:00 GMT");
    expect(text(items[0]!, "dc:creator")).toBe("Sara Janssens");
    expect(text(items[0]!, "category")).toBe("Web Development");
    expect(text(items[0]!, "description")).toBe("From concept to deployment.");
  });

  it("uses the newest article's date as lastBuildDate, not the current time", () => {
    const xml = feed([
      item({ publishedAt: new Date("2026-11-20T00:00:00Z") }),
      item({ publishedAt: new Date("2026-11-27T08:30:00Z") }),
    ]);
    expect(parse(xml).getElementsByTagName("lastBuildDate")[0]!.textContent).toBe("Fri, 27 Nov 2026 08:30:00 GMT");
  });

  it("leaves out dc:creator and category when there is none, and is valid with no articles at all", () => {
    const one = parse(feed([item({ author: null, category: null })]));
    expect(one.getElementsByTagName("dc:creator")).toHaveLength(0);
    expect(one.getElementsByTagName("category")).toHaveLength(0);
    const none = parse(feed([]));
    expect(none.getElementsByTagName("item")).toHaveLength(0);
    expect(none.getElementsByTagName("lastBuildDate")).toHaveLength(0);
  });

  it("survives hostile and awkward text in every field, and gives it back exactly", () => {
    const nasty = `<script>alert("x")</script> & ]]> 'q' ${String.fromCharCode(0)}${String.fromCharCode(11)}${String.fromCharCode(0xd800)} é 日本語 😀`;
    const dropped = new Set([0, 11, 0xd800]);
    const clean = [...nasty].filter((ch) => !dropped.has(ch.codePointAt(0)!)).join("");
    const doc = parse(
      feed([item({ title: nasty, summary: nasty, author: nasty, category: nasty, url: `https://x.test/a?b=1&c="2"` })]),
    );
    const first = doc.getElementsByTagName("item")[0]!;
    for (const name of ["title", "description", "dc:creator", "category"]) {
      expect(first.getElementsByTagName(name)[0]!.textContent, name).toBe(clean);
    }
    expect(first.getElementsByTagName("link")[0]!.textContent).toBe(`https://x.test/a?b=1&c="2"`);
    expect(doc.getElementsByTagName("script")).toHaveLength(0); // it stayed text; it never became an element
  });

  it("passes an independent XML parser (xmllint)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feed-"));
    try {
      const file = path.join(dir, "feed.xml");
      writeFileSync(file, feed([item(), item({ title: `Q&A <b> "x" ${String.fromCharCode(0)}` })]));
      expect(() => execFileSync("xmllint", ["--noout", file], { stdio: "pipe" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("excerpt", () => {
  it("returns short text whole, and cuts long text at a word with an ellipsis", () => {
    expect(excerpt("A short summary.")).toBe("A short summary.");
    const long = "word ".repeat(200);
    const cut = excerpt(long, 100);
    expect(cut.length).toBeLessThanOrEqual(101);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.endsWith("word…")).toBe(true); // never mid-word
  });

  it("drops markdown heading marks and collapses whitespace", () => {
    expect(excerpt("# Title\n\nFirst   line\nsecond line")).toBe("Title First line second line");
    expect(excerpt("   ")).toBe("");
  });
});

describe("conditional requests", () => {
  it("gives the same ETag for the same feed and a different one when it changes", () => {
    expect(etagOf(feed([item()]))).toBe(etagOf(feed([item()])));
    expect(etagOf(feed([item()]))).not.toBe(etagOf(feed([item({ title: "Changed" })])));
    expect(etagOf("x")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("matches If-None-Match as a list, with weak validators, and with *", () => {
    const tagged = etagOf("body");
    expect(matchesEtag(tagged, tagged)).toBe(true);
    expect(matchesEtag(`W/${tagged}`, tagged)).toBe(true);
    expect(matchesEtag(`"other", ${tagged}`, tagged)).toBe(true);
    expect(matchesEtag("*", tagged)).toBe(true);
    expect(matchesEtag('"other"', tagged)).toBe(false);
    expect(matchesEtag(null, tagged)).toBe(false);
    expect(matchesEtag("", tagged)).toBe(false);
  });
});

describe("feed discovery", () => {
  it("offers the feed's address and type", () => {
    expect(feedAlternates()).toEqual({
      "application/rss+xml": [{ url: "/feed.xml", title: "ASafariM Knowledge" }],
    });
  });

  it("is kept by every page that sets its own `alternates` (Next.js replaces the layout's, it doesn't merge)", () => {
    const root = path.resolve(import.meta.dirname, "../app");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const setters = files.filter((f) => /\balternates\s*:/.test(readFileSync(f, "utf8")));
    expect(setters.length).toBeGreaterThanOrEqual(3); // the layout, the article page and the lesson page, at least
    for (const f of setters) {
      expect(readFileSync(f, "utf8"), path.relative(root, f)).toContain("feedAlternates()");
    }
  });
});
