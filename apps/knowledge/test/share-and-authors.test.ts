import { describe, expect, it } from "vitest";
import { cleanDisplayName, initialsOf, MAX_NAME } from "../lib/authors";
import { formatPublished } from "../lib/format";
import { readingMinutes } from "../lib/reading-time";
import { shareLinks } from "../lib/share";
import { articleUrl, publicOrigin } from "../lib/site";

describe("the public address", () => {
  it("is the manifest's primary domain, over https, unless overridden", () => {
    expect(publicOrigin({})).toBe("https://learn.asafarim.site");
    expect(articleUrl("hello-world", publicOrigin({}))).toBe("https://learn.asafarim.site/articles/hello-world");
  });

  it("accepts an http(s) override (local development) and keeps only its origin", () => {
    expect(publicOrigin({ KNOWLEDGE_PUBLIC_ORIGIN: "http://localhost:4140/some/path?x=1" })).toBe(
      "http://localhost:4140",
    );
    expect(publicOrigin({ KNOWLEDGE_PUBLIC_ORIGIN: " https://example.test " })).toBe("https://example.test");
  });

  it("ignores an override that isn't a plain web origin", () => {
    for (const bad of ["", "   ", "not a url", "javascript:alert(1)", "ftp://x.test", "data:text/html,<b>"]) {
      expect(publicOrigin({ KNOWLEDGE_PUBLIC_ORIGIN: bad }), bad).toBe("https://learn.asafarim.site");
    }
  });
});

describe("share links", () => {
  const url = "https://learn.asafarim.site/articles/ai-apps";

  it("builds the LinkedIn, X and email links exactly", () => {
    const [linkedin, x, email] = shareLinks({ url, title: "Building AI-Powered Web Apps" });
    expect(linkedin).toEqual({
      id: "linkedin",
      label: "LinkedIn",
      href: "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Flearn.asafarim.site%2Farticles%2Fai-apps",
    });
    expect(x).toEqual({
      id: "x",
      label: "X",
      href: "https://x.com/intent/post?text=Building%20AI-Powered%20Web%20Apps&url=https%3A%2F%2Flearn.asafarim.site%2Farticles%2Fai-apps",
    });
    expect(email).toEqual({
      id: "email",
      label: "Email",
      href: "mailto:?subject=Building%20AI-Powered%20Web%20Apps&body=Building%20AI-Powered%20Web%20Apps%0A%0Ahttps%3A%2F%2Flearn.asafarim.site%2Farticles%2Fai-apps",
    });
  });

  it("keeps a title with &, #, ?, quotes and non-Latin text from breaking out of its parameter", () => {
    const title = `Q&A: "C# vs F#?" & 日本語 100%`;
    const hrefs = shareLinks({ url, title }).map((l) => l.href);
    for (const href of hrefs) {
      // Round trip: the value a network reads back is exactly the title.
      const text = href.startsWith("mailto:")
        ? new URLSearchParams(href.slice("mailto:?".length)).get("subject")
        : new URL(href).searchParams.get("text");
      if (href.includes("linkedin")) expect(new URL(href).searchParams.get("url")).toBe(url);
      else expect(text).toBe(title);
    }
    // Nothing extra sneaks in as a parameter.
    expect([...new URL(hrefs[1]!).searchParams.keys()]).toEqual(["text", "url"]);
    expect([...new URL(hrefs[0]!).searchParams.keys()]).toEqual(["url"]);
  });

  it("shortens a very long title for X only", () => {
    const long = "word ".repeat(100).trim();
    const [, x, email] = shareLinks({ url, title: long });
    const text = new URL(x!.href).searchParams.get("text")!;
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith("…")).toBe(true);
    expect(decodeURIComponent(email!.href)).toContain(long); // email keeps the whole title
  });

  it("only ever shares a web address", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/articles/x", "ftp://x.test/a", ""]) {
      expect(shareLinks({ url: bad, title: "T" }), bad).toEqual([]);
    }
  });
});

describe("reading time", () => {
  it("is at least a minute, and rounds up at 200 words a minute", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("   \n ")).toBe(1);
    expect(readingMinutes("word ".repeat(200))).toBe(1);
    expect(readingMinutes("word ".repeat(201))).toBe(2);
    expect(readingMinutes("word ".repeat(1000))).toBe(5);
  });
});

describe("publication dates", () => {
  it("read the same in every time zone", () => {
    expect(formatPublished(new Date("2026-11-27T23:59:59Z"))).toBe("27 Nov 2026");
    expect(formatPublished(new Date("2026-01-05T00:00:00Z"))).toBe("5 Jan 2026");
  });
});

describe("author display names", () => {
  it("keeps an ordinary name, tidied", () => {
    expect(cleanDisplayName("Ali Safari")).toBe("Ali Safari");
    expect(cleanDisplayName("  Ali   Safari \n")).toBe("Ali Safari");
    expect(cleanDisplayName("Zoë Müller-Çelik")).toBe("Zoë Müller-Çelik");
  });

  it("never publishes an email address as a name", () => {
    for (const emailish of ["ali@example.com", "Ali <ali@example.com>", "a@b", "ali.safari@gmail.com (Ali)"]) {
      expect(cleanDisplayName(emailish), emailish).toBeNull();
    }
  });

  it("drops invisible and direction-changing characters, and refuses nothing-but-those", () => {
    expect(cleanDisplayName("Ali\u200b Safari")).toBe("Ali Safari");
    expect(cleanDisplayName("Ali \u202eiraafaS\u202c")).toBe("Ali iraafaS"); // the override that would flip the text
    expect(cleanDisplayName("\u200b\u200b\u202e")).toBeNull();
    expect(cleanDisplayName("Ali\u0000Safari")).toBe("Ali Safari");
  });

  it("keeps the joiners that real names are spelled with (Persian, Indic)", () => {
    expect(cleanDisplayName("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")).toBe(
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
    );
    expect(cleanDisplayName("\u0dc1\u0dca\u200d\u0dbb\u0dd3")).toBe("\u0dc1\u0dca\u200d\u0dbb\u0dd3");
  });

  it("refuses what isn't text, and caps the length", () => {
    for (const notAName of [undefined, null, 42, {}, [], "", "   "]) expect(cleanDisplayName(notAName)).toBeNull();
    expect(cleanDisplayName("x".repeat(500))!.length).toBe(MAX_NAME);
  });

  it("makes avatar initials", () => {
    expect(initialsOf("Ali Safari")).toBe("AS");
    expect(initialsOf("ali de la safari")).toBe("AS"); // first and last word
    expect(initialsOf("Madonna")).toBe("MA");
    expect(initialsOf("Émile Zola")).toBe("ÉZ");
    expect(initialsOf(null)).toBe("K");
    expect(initialsOf("")).toBe("K");
  });
});
