/**
 * asafarim.site in English, Dutch, French and German (src/i18n.ts, src/progress-i18n.ts), with @asafarim/locale's
 * country & language selector on every page.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSite, loadProgress } from "../src/build.ts";
import { localePath, SITE_LOCALES, TEXT } from "../src/i18n.ts";
import { LEGAL_DOCS } from "../src/legal.ts";
import { localizeProgress, PROGRESS_TEXT } from "../src/progress-i18n.ts";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.join(siteDir, "..", "..");
const progress = loadProgress(path.join(siteDir, "src", "progress.json"));
const out = mkdtempSync(path.join(tmpdir(), "site-i18n-"));
const written = buildSite(siteDir, out);
const read = (name: string) => readFileSync(path.join(out, name), "utf8");
const dirOf = (l: string) => localePath(l as never).slice(1);

describe("asafarim.site in four languages", () => {
  it("writes the home page and every legal page in each language", () => {
    for (const l of SITE_LOCALES)
      for (const page of ["index", ...LEGAL_DOCS.map((d) => d.slug)])
        expect(written).toContain(`${dirOf(l)}${page}.html`);
  });

  it("gives each page its language, its own canonical URL and every language's alternate", () => {
    for (const l of SITE_LOCALES) {
      const html = read(`${dirOf(l)}index.html`);
      const url = `https://asafarim.site${localePath(l)}`;
      expect(html).toContain(`<html lang="${l}">`);
      expect(html).toContain(`<title>${TEXT[l].title}</title>`);
      expect(html).toContain(`<link rel="canonical" href="${url}" />`);
      expect(html).toContain(`<meta property="og:url" content="${url}" />`);
      for (const other of SITE_LOCALES)
        expect(html).toContain(
          `<link rel="alternate" hreflang="${other}" href="https://asafarim.site${localePath(other)}" />`,
        );
      expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://asafarim.site/" />');
    }
  });

  it("mounts the language selector in the top bar, its fallback links going to the same page in each language", () => {
    for (const l of SITE_LOCALES) {
      const html = read(`${dirOf(l)}cookies.html`);
      const mount = new RegExp(
        `<li class="nav-locale"><div class="locale-selector nav-locale-selector" data-locale-selector data-lang="${l}">`,
      );
      expect(html).toMatch(mount);
      expect(html).toContain(`<span aria-current="true" lang="${l}">${l.toUpperCase()}</span>`);
      for (const other of SITE_LOCALES.filter((o) => o !== l))
        expect(html).toContain(`<a href="${localePath(other, "cookies")}" hreflang="${other}"`);
      expect(html).toContain('<link rel="stylesheet" href="/selector.css" />');
      expect(html).toContain('<script src="/selector.js" defer></script>');
    }
  });

  it("ships @asafarim/locale's selector byte for byte", () => {
    for (const name of ["selector.js", "selector.css"])
      expect(read(name)).toBe(readFileSync(path.join(repoDir, "packages", "locale", name), "utf8"));
  });

  it("translates the page: hero, sections, statuses, footer and dates", () => {
    const nl = read("nl/index.html");
    expect(nl).toContain("<summary>Apps <svg");
    expect(nl).toContain("Ingebouwd in het OS");
    expect(nl).toContain(">Aanmelden</a>");
    expect(nl).toMatch(
      /<span class="badge">In ontwikkeling · bijgewerkt op \d+ (jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec) \d{4}<\/span>/,
    );
    expect(nl).toContain('<a href="/nl/privacy">Privacy</a>');
    expect(read("fr/index.html")).toContain("Se connecter");
    expect(read("de/index.html")).toContain("Im OS enthalten");
    // products in the page's language where their site has it
    expect(read("fr/index.html")).toContain('href="https://igs.asafarim.site/fr/"');
    expect(nl).toContain('href="https://breinhap.asafarim.site/"');
    expect(read("de/index.html")).toContain('href="https://breinhap.asafarim.site/en/"');
  });

  it("keeps the changelog in English, marked as such, on the translated pages", () => {
    expect(read("index.html")).toContain('<ol class="milestones">');
    for (const l of ["nl", "fr", "de"]) {
      const html = read(`${l}/index.html`);
      expect(html).toContain('<ol class="milestones" lang="en">');
      expect(html).toContain(TEXT[l as "nl"].shipped.inEnglish);
    }
  });

  it('says a legal text is English for now, and marks it lang="en"', () => {
    const de = read("de/privacy.html");
    expect(de).toContain("<h1>Datenschutzerklärung</h1>");
    expect(de).toContain('<p class="legal-language" role="note">Dieser Text ist vorerst nur auf Englisch verfügbar.');
    expect(de).toContain('<div class="legal-body" lang="en">');
    expect(read("privacy.html")).not.toContain("legal-language");
  });

  it("translates every app, screenshot, roadmap item and link in the progress file, surface for surface", () => {
    for (const l of ["nl", "fr", "de"] as const) {
      const t = PROGRESS_TEXT[l];
      expect(Object.keys(t.apps).sort()).toEqual(progress.apps.map((a) => a.id).sort());
      expect(Object.keys(t.screenshots).sort()).toEqual(progress.screenshots.map((s) => s.file).sort());
      expect(Object.keys(t.roadmap).sort()).toEqual(progress.roadmap.map((r) => r.id).sort());
      expect(Object.keys(t.links).sort()).toEqual(progress.links.map((x) => x.href).sort());
      const local = localizeProgress(progress, l);
      local.apps.forEach((a, i) => {
        expect(a.surfaces.map((s) => s.status)).toEqual(progress.apps[i]!.surfaces.map((s) => s.status));
        expect(a.summary).not.toBe(progress.apps[i]!.summary);
      });
    }
  });

  it("gives every language the same words in TEXT and session.js", () => {
    const keys = (o: object) => Object.keys(o).sort();
    for (const l of SITE_LOCALES) expect(keys(TEXT[l])).toEqual(keys(TEXT.en));
    const script = readFileSync(path.join(siteDir, "public", "session.js"), "utf8");
    const words = /const WORDS = (\{[\s\S]*?\n {2}\});/.exec(script)?.[1] ?? "{}";
    const parsed = new Function(`return ${words}`)() as Record<string, object>;
    expect(keys(parsed)).toEqual([...SITE_LOCALES].sort());
    for (const l of SITE_LOCALES) expect(keys(parsed[l]!)).toEqual(keys(parsed.en!));
  });

  it("lists every language in the sitemap", () => {
    const sitemap = read("sitemap.xml");
    for (const url of [
      "https://asafarim.site/nl/",
      "https://asafarim.site/fr/cookies",
      "https://asafarim.site/de/terms",
    ])
      expect(sitemap).toContain(`<loc>${url}</loc>`);
  });

  it("sends a visitor who chose another language from / to it (nginx), and lists the cookie in the cookie policy", () => {
    const nginx = readFileSync(path.join(siteDir, "nginx.conf"), "utf8");
    expect(nginx).toMatch(
      /location = \/ \{\s*if \(\$cookie_asafarim_locale ~ "\^\(nl\|fr\|de\)\$"\) \{\s*return 302 \/\$1\/;/,
    );
    expect(read("cookies.html")).toContain("<code>asafarim-locale</code>");
  });
});

it("makes Observatory discoverable in both navigation menus, product cards and footer in every language", () => {
  for (const locale of SITE_LOCALES) {
    const html = read(`${dirOf(locale)}index.html`);
    const target = 'href="https://observatory.asafarim.site/"';
    const nav = html.slice(
      html.indexOf('<nav class="topbar"'),
      html.indexOf("</nav>", html.indexOf('<nav class="topbar"')),
    );
    expect(nav.split(target).length - 1).toBe(2);
    expect(html).toContain('id="app-observatory"');
    expect(html.slice(html.indexOf("<footer>"))).toContain(target);
    const card = html.slice(
      html.indexOf('id="app-observatory"'),
      html.indexOf("</li>", html.indexOf('id="app-observatory"')),
    );
    expect(card).toContain(target);
    expect(card).toContain("status-live");
    expect(card).not.toContain("coming-soon");
  }
});
