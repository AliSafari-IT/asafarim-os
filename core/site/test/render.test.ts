import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAllowedLink, parseProgress, type Progress } from "../src/progress.ts";
import { APP_LINKS, DESCRIPTION, IDENTITY_ORIGIN, TITLE, escapeHtml, formatDate, renderPage } from "../src/render.ts";

const progress: Progress = parseProgress({
  updated: "2026-10-10",
  repo: "https://github.com/AliSafari-IT/asafarim-os",
  shipped: [{ id: "P0", title: "Foundations <b>", date: "2026-10-03", summary: "A & B", prs: [1, 12] }],
  screenshots: [{ file: "apps.png", title: "Apps", alt: 'The "Apps" page', caption: "Every app." }],
  roadmap: [{ id: "P6", title: "Observability", summary: "Telemetry." }],
  links: [{ label: "GitHub repository", href: "https://github.com/AliSafari-IT/asafarim-os" }],
});
const imageSizes = new Map([["apps.png", { width: 1280, height: 800 }]]);

describe("renderPage", () => {
  const html = renderPage(progress, { imageSizes });

  it("has a title, a meta description, a viewport and a language", () => {
    expect(html).toContain(`<title>${escapeHtml(TITLE)}</title>`);
    expect(html).toContain(`<meta name="description" content="${escapeHtml(DESCRIPTION)}" />`);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    expect(html).toContain('<html lang="en">');
  });

  it("renders the Shipped, Screenshots and Roadmap sections from the progress file", () => {
    for (const id of ["shipped", "screenshots", "roadmap"]) expect(html).toContain(`<section id="${id}"`);
    expect(html).toContain('<a href="https://github.com/AliSafari-IT/asafarim-os/pull/12">#12</a>');
    expect(html).toContain('<time datetime="2026-10-03">3 Oct 2026</time>');
    expect(html).toContain("Observability");
  });

  it("escapes everything it takes from the progress file", () => {
    expect(html).toContain("Foundations &lt;b&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain('alt="The &quot;Apps&quot; page"');
  });

  it("gives every image its alt text and its size", () => {
    expect(html).toMatch(/<img src="screenshots\/apps\.png" alt="[^"]+" width="1280" height="800"/);
    for (const img of html.match(/<img [^>]*>/g) ?? []) expect(img).toMatch(/ alt="[^"]+"/);
  });

  it("has its own scripts only and no inline scripts, inline styles or third-party assets (the CSP allows none)", () => {
    // theme.js runs before paint (no flash of the other theme); session.js after parsing.
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script src="theme.js">', '<script src="session.js" defer>']);
    expect(html).not.toMatch(/<script[^>]*>[^<]|\sstyle=|<style|\son[a-z]+=/i);
    for (const [, url] of html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)) {
      expect(url).toMatch(/^https:\/\/(github\.com|asafarim\.com|((docs|id|breinhap)\.)?asafarim\.site)\//);
    }
    // Stylesheet and icon are this origin's own; only the canonical link names a full URL.
    expect(html).not.toMatch(/<link rel="(?!canonical")[^"]+" [^>]*href="https?:/);
  });

  it("has a top bar with the way to sign in and to the docs, on allowed hosts", () => {
    const nav = /<nav class="topbar" aria-label="Main">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    expect(nav).toContain('<a href="https://docs.asafarim.site/">Docs</a>');
    expect(nav).toContain('<a href="https://breinhap.asafarim.site/en/">Breinhap</a>');
    expect(nav).toContain('<a href="https://id.asafarim.site/login" class="btn btn-small">Sign in</a>');
    // session.js swaps the "Sign in" slot for the avatar, asking identity at this origin.
    expect(nav).toContain('<li id="account">');
    const script = readFileSync(new URL("../public/session.js", import.meta.url), "utf8");
    expect(script).toContain(`const identity = "${IDENTITY_ORIGIN}";`);
    for (const link of Object.values(APP_LINKS)) expect(isAllowedLink(link.href)).toBe(true);
    expect(html).toMatch(/Request connection/);
  });

  it("puts the light/dark toggle in the top bar and loads the shared theme before its own styles", () => {
    const toggle = '<button type="button" class="os-theme-toggle" data-theme-toggle>T</button>';
    const themed = renderPage(progress, { imageSizes, themeToggle: toggle });
    const nav = /<nav class="topbar" aria-label="Main">([\s\S]*?)<\/nav>/.exec(themed)?.[1] ?? "";
    expect(nav).toContain(`<li>${toggle}</li>`);
    expect(themed).toMatch(/<div class="os-topbar">\s*<nav class="topbar"/);
    expect(themed.indexOf('href="theme.css"')).toBeLessThan(themed.indexOf('href="styles.css"'));
    expect(html).not.toContain("os-theme-toggle"); // none given, none drawn
  });

  it("links Breinhap's English page from the top bar, a section of its own and the footer", () => {
    expect(html).toMatch(/<section id="more"[\s\S]*?<a href="https:\/\/breinhap\.asafarim\.site\/en\/">Breinhap<\/a>/);
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
    expect(footer).toContain('<a href="https://breinhap.asafarim.site/en/">Breinhap</a>');
  });

  it("frames the OS as a new base platform, not a migration", () => {
    expect(html).toMatch(/operating system that apps plug into/);
    expect(html).toMatch(/not a migration/);
    expect(html).not.toMatch(/until (its|the) apps migrate|migrating/i);
  });

  it("fails loudly when a listed screenshot has no size (missing file)", () => {
    expect(() => renderPage(progress, { imageSizes: new Map() })).toThrow(/apps\.png/);
  });
});

describe("formatDate", () => {
  it("is locale-free", () => {
    expect(formatDate("2026-01-09")).toBe("9 Jan 2026");
    expect(formatDate("2026-12-31")).toBe("31 Dec 2026");
  });
});
