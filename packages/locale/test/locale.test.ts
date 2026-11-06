import { describe, expect, it } from "vitest";
import {
  alternateLinks,
  cookieDomain,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  localeCookie,
  localeFromAcceptLanguage,
  localeFromCookieHeader,
  LOCALES,
  localeSwitcher,
  negotiateLocale,
  parseLocale,
} from "../src/index.ts";

describe("@asafarim/locale", () => {
  it("speaks Belgium's three languages plus English, English first", () => {
    expect(LOCALES).toEqual(["en", "nl", "fr", "de"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALE_COOKIE).toBe("asafarim-locale");
  });

  it("reads a locale from tags, cookies and Accept-Language", () => {
    expect(parseLocale("nl-BE")).toBe("nl");
    expect(parseLocale(" FR ")).toBe("fr");
    expect(parseLocale("de_BE")).toBe("de");
    expect(parseLocale("es")).toBeUndefined();
    expect(parseLocale("")).toBeUndefined();
    expect(localeFromCookieHeader("a=1; asafarim-locale=fr; asafarim-theme=dark")).toBe("fr");
    expect(localeFromCookieHeader("asafarim-locale=xx")).toBeUndefined();
    expect(localeFromAcceptLanguage("es-ES,fr-BE;q=0.8,nl;q=0.9")).toBe("nl");
    expect(localeFromAcceptLanguage("de-BE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(localeFromAcceptLanguage("nl;q=0, fr;q=0.1")).toBe("fr");
    expect(localeFromAcceptLanguage("es, it")).toBeUndefined();
  });

  it("chooses the URL, then the remembered choice, then the browser, then English", () => {
    const all = { query: "de", cookieHeader: "asafarim-locale=fr", acceptLanguage: "nl" };
    expect(negotiateLocale(all)).toEqual({ locale: "de", source: "query" });
    expect(negotiateLocale({ ...all, query: "zz" })).toEqual({ locale: "fr", source: "cookie" });
    expect(negotiateLocale({ acceptLanguage: "nl-BE" })).toEqual({ locale: "nl", source: "browser" });
    expect(negotiateLocale({})).toEqual({ locale: "en", source: "default" });
    expect(negotiateLocale({}, "nl")).toEqual({ locale: "nl", source: "default" });
  });

  it("remembers the choice on the parent domain, and only on the host locally", () => {
    expect(cookieDomain("id.asafarim.site")).toBe("asafarim.site");
    expect(cookieDomain("asafarim.site:443")).toBe("asafarim.site");
    expect(cookieDomain("localhost")).toBe("");
    expect(cookieDomain("app.localhost")).toBe("");
    expect(cookieDomain("127.0.0.1")).toBe("");
    expect(localeCookie("nl", "docs.asafarim.site")).toBe(
      "asafarim-locale=nl; Path=/; Max-Age=31536000; SameSite=Lax; Secure; Domain=asafarim.site",
    );
    expect(localeCookie("fr", "localhost")).toBe("asafarim-locale=fr; Path=/; Max-Age=31536000; SameSite=Lax");
  });

  it("renders the selector's mount with a plain link per language as the fallback", () => {
    const html = localeSwitcher("fr", (l) => (l === "en" ? "/" : `/${l}/?a=1&b="2"`));
    expect(html).toMatch(
      /^<div class="locale-selector" data-locale-selector data-lang="fr"><div class="locale-links" role="group" aria-label="[^"]+">/,
    );
    expect(html).toContain('<span aria-current="true" lang="fr">FR</span>');
    expect(html).toContain('<a href="/" hreflang="en" lang="en" title="English">EN</a>');
    expect(html).toContain('<a href="/nl/?a=1&amp;b=&quot;2&quot;" hreflang="nl" lang="nl" title="Nederlands">NL</a>');
    expect(html).not.toMatch(/hreflang="fr"/);
    expect(localeSwitcher("en", () => "/", { className: "topbar-locale" })).toContain(
      'class="locale-selector topbar-locale"',
    );
  });

  it("lists every language's URL for search engines, English as x-default", () => {
    const links = alternateLinks((l) => `https://asafarim.site/${l === "en" ? "" : `${l}/`}`);
    expect(links.split("\n").map((l) => l.trim())).toEqual([
      '<link rel="alternate" hreflang="en" href="https://asafarim.site/" />',
      '<link rel="alternate" hreflang="nl" href="https://asafarim.site/nl/" />',
      '<link rel="alternate" hreflang="fr" href="https://asafarim.site/fr/" />',
      '<link rel="alternate" hreflang="de" href="https://asafarim.site/de/" />',
      '<link rel="alternate" hreflang="x-default" href="https://asafarim.site/" />',
    ]);
  });
});
