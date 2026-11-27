import { describe, expect, it } from "vitest";
import {
  cleanSearchTerm,
  isShareTarget,
  looksLikeBot,
  optedOut,
  readerName,
  refererSource,
  shouldCountView,
  viewKey,
} from "../lib/analytics/classify";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const headers = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

describe("what counts as a view", () => {
  it("counts a full page load by a browser", () => {
    expect(
      shouldCountView(headers({ "user-agent": CHROME, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" })),
    ).toBe(true);
  });

  it("counts the app's own client fetching the next page after a click (not a prefetch)", () => {
    // What page code really sees: Next strips RSC, so it is the browser's own fetch metadata that says so.
    const soft = {
      "user-agent": CHROME,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    expect(shouldCountView(headers(soft))).toBe(true);
    expect(shouldCountView(headers({ "user-agent": CHROME, "sec-fetch-dest": "empty", rsc: "1" }))).toBe(true); // if it is visible
    // A fetch from another site, or a plain fetch that is not a same-origin one, is not a person reading this site.
    expect(shouldCountView(headers({ ...soft, "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(shouldCountView(headers({ ...soft, "sec-fetch-site": "same-site" }))).toBe(false);
    expect(shouldCountView(headers({ ...soft, "sec-fetch-mode": "no-cors" }))).toBe(false);
    expect(shouldCountView(headers({ ...soft, "next-router-prefetch": "1" }))).toBe(false); // a prefetch, if the header is visible
  });

  it("does not count a prefetch or prerender, by any of the headers that say so", () => {
    const prefetchHeaders: Record<string, string>[] = [
      { "next-router-prefetch": "1" },
      { purpose: "prefetch" },
      { "sec-purpose": "prefetch;prerender" },
      { "sec-purpose": "prefetch" },
    ];
    for (const extra of prefetchHeaders) {
      expect(
        shouldCountView(headers({ "user-agent": CHROME, "sec-fetch-dest": "document", ...extra })),
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("does not count images, iframes, scripts or a plain fetch that isn't the app's own navigation", () => {
    for (const dest of ["image", "iframe", "script", "style", "font", "empty"]) {
      expect(shouldCountView(headers({ "user-agent": CHROME, "sec-fetch-dest": dest })), dest).toBe(false);
    }
  });

  it("does not count bots, scripts, monitors, headless browsers or a missing user agent", () => {
    for (const ua of [
      "Googlebot/2.1 (+http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0)",
      "curl/8.4.0",
      "python-requests/2.31",
      "Go-http-client/2.0",
      "UptimeRobot/2.0",
      "facebookexternalhit/1.1",
      "LinkedInBot/1.0",
      "Twitterbot/1.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0.0.0 Safari/537.36",
      "Lighthouse",
      "",
    ]) {
      expect(shouldCountView(headers({ "user-agent": ua, "sec-fetch-dest": "document" })), ua).toBe(false);
    }
    expect(shouldCountView(headers({ "sec-fetch-dest": "document" }))).toBe(false);
  });

  it("respects Global Privacy Control and Do Not Track", () => {
    const base = { "user-agent": CHROME, "sec-fetch-dest": "document" };
    expect(shouldCountView(headers({ ...base, "sec-gpc": "1" }))).toBe(false);
    expect(shouldCountView(headers({ ...base, dnt: "1" }))).toBe(false);
    expect(shouldCountView(headers({ ...base, dnt: "0" }))).toBe(true);
    expect(optedOut(headers({ "sec-gpc": "1" }))).toBe(true);
    expect(optedOut(headers({}))).toBe(false);
  });

  it("falls back to the user agent for a browser too old to send fetch metadata", () => {
    expect(shouldCountView(headers({ "user-agent": CHROME }))).toBe(true);
    expect(shouldCountView(headers({ "user-agent": "SomeScript/1.0" }))).toBe(false);
  });

  it("looksLikeBot", () => {
    expect(looksLikeBot(null)).toBe(true);
    expect(looksLikeBot(CHROME)).toBe(false);
  });
});

describe("referring sites", () => {
  const own = ["learn.asafarim.site"];

  it("keeps only the host name: never a path, query, fragment, port or credentials", () => {
    expect(refererSource("https://news.ycombinator.com/item?id=123&secret=abc#c", own)).toBe("news.ycombinator.com");
    expect(refererSource("https://user:pass@blog.example.com:8443/a/b?q=1", own)).toBe("blog.example.com");
    expect(refererSource("https://WWW.Example.COM./x", own)).toBe("example.com");
  });

  it("is empty for direct visits, this app's own pages, junk, non-web schemes, IPs and bare names", () => {
    for (const r of [
      null,
      "",
      "not a url",
      "android-app://com.google.android.gm",
      "ftp://x.test/",
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "https://intranet/",
    ]) {
      expect(refererSource(r, own), String(r)).toBe("");
    }
    expect(refererSource("https://learn.asafarim.site/articles/a", own)).toBe("");
    expect(refererSource("https://www.learn.asafarim.site/", own)).toBe("");
  });

  it("keeps a sibling asafarim.site app as a source", () => {
    expect(refererSource("https://hub.asafarim.site/", own)).toBe("hub.asafarim.site");
  });

  it("merges well-known aliases and the search engine's country sites", () => {
    expect(refererSource("https://t.co/abc", own)).toBe("x.com");
    expect(refererSource("https://twitter.com/x/status/1", own)).toBe("x.com");
    expect(refererSource("https://lnkd.in/abc", own)).toBe("linkedin.com");
    expect(refererSource("https://www.linkedin.com/feed/", own)).toBe("linkedin.com");
    expect(refererSource("https://www.google.be/", own)).toBe("google.com");
    expect(refererSource("https://www.google.co.uk/search?q=secret", own)).toBe("google.com");
    expect(refererSource("https://l.facebook.com/l.php?u=x", own)).toBe("facebook.com");
  });

  it("caps the length", () => {
    expect(refererSource(`https://${"a".repeat(300)}.com/`, own).length).toBeLessThanOrEqual(100);
  });
});

describe("search terms", () => {
  it("keeps an ordinary term, tidied and lower-cased", () => {
    expect(cleanSearchTerm("  React   Hooks ")).toBe("react hooks");
    expect(cleanSearchTerm("useEffect")).toBe("useeffect");
    expect(cleanSearchTerm("日本語 検索")).toBe("日本語 検索");
  });

  it("drops what could identify a person: emails, addresses, web addresses, long digit runs", () => {
    for (const bad of [
      "john.doe@example.com",
      "mail me at x@y.z",
      "https://example.com/private",
      "http:foo",
      "www.example.com",
      "call +32 470 12 34 56",
      "4111 1111 1111 1111",
      "0470/12.34.56",
      "id 12345678",
    ]) {
      expect(cleanSearchTerm(bad), bad).toBeNull();
    }
  });

  it("drops anything longer than four words, which is more likely a name or an address than a topic", () => {
    expect(cleanSearchTerm("rue de la loi brussels")).toBeNull();
    expect(cleanSearchTerm("how to deploy next js")).toBeNull();
    expect(cleanSearchTerm("deploy next js app")).toBe("deploy next js app");
  });

  it("keeps short digit runs (a version, a year, a port)", () => {
    expect(cleanSearchTerm("node 22.11")).toBe("node 22.11");
    expect(cleanSearchTerm("react 19")).toBe("react 19");
    expect(cleanSearchTerm("port 8080")).toBe("port 8080");
  });

  it("drops what is too short, too long, empty, a control character or not text", () => {
    for (const bad of ["", " ", "a", "x".repeat(61), `a${String.fromCharCode(7)}b`, undefined, null, 42, {}, []]) {
      expect(cleanSearchTerm(bad)).toBeNull();
    }
    expect(cleanSearchTerm("x".repeat(60))).toBe("x".repeat(60));
  });
});

describe("feed readers", () => {
  it("names well-known readers from a short allow-list", () => {
    expect(
      readerName("Feedly/1.0 (+http://www.feedly.com/fetcher.html; 12 subscribers; like FeedFetcher-Google)"),
    ).toBe("Feedly");
    expect(readerName("Inoreader/1.0 (+http://www.inoreader.com/feed-fetcher; 3 subscribers)")).toBe("Inoreader");
    expect(readerName("NetNewsWire (RSS Reader; https://netnewswire.com/)")).toBe("NetNewsWire");
    expect(readerName("Mozilla/5.0 (X11; Linux) Thunderbird/128.0")).toBe("Thunderbird");
  });

  it("never keeps the raw browser string: a person's browser is 'Browser', an unknown reader 'Other'", () => {
    expect(readerName(CHROME)).toBe("Browser");
    expect(readerName("SomeRssApp/2.1")).toBe("Other");
  });

  it("does not count crawlers or scripts", () => {
    for (const ua of ["Googlebot/2.1", "curl/8.4.0", "python-requests/2.31", "", null])
      expect(readerName(ua), String(ua)).toBeNull();
  });
});

describe("labels", () => {
  it("builds page keys in one place", () => {
    expect(viewKey.home).toBe("home");
    expect(viewKey.article("ai-apps")).toBe("article:ai-apps");
    expect(viewKey.topic("web")).toBe("topic:web");
    expect(viewKey.course("ship-it")).toBe("course:ship-it");
  });

  it("knows the share targets", () => {
    for (const t of ["linkedin", "x", "email", "copy"]) expect(isShareTarget(t)).toBe(true);
    for (const t of ["facebook", "", null, undefined, 1, "LinkedIn"]) expect(isShareTarget(t)).toBe(false);
  });
});
