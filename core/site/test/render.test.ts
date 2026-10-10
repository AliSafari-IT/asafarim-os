import { describe, expect, it } from "vitest";
import { parseProgress, type Progress } from "../src/progress.ts";
import { DESCRIPTION, TITLE, escapeHtml, formatDate, renderPage } from "../src/render.ts";

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

  it("has no scripts, no inline styles and no third-party assets (the CSP allows none)", () => {
    expect(html).not.toMatch(/<script|\sstyle=|<style|\son[a-z]+=/i);
    for (const [, url] of html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)) {
      expect(url).toMatch(/^https:\/\/(github\.com|asafarim\.com|asafarim\.site)\//);
    }
    // Stylesheet and icon are this origin's own; only the canonical link names a full URL.
    expect(html).not.toMatch(/<link rel="(?!canonical")[^"]+" [^>]*href="https?:/);
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
