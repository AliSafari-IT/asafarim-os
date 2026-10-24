import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTACT_EMAIL, LEGAL_DOCS } from "../src/legal.ts";
import { renderLegalPage } from "../src/render.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (file: string) => readFileSync(path.join(repoRoot, file), "utf8");
const repo = "https://github.com/AliSafari-IT/asafarim-os";
const docOf = (slug: string) => LEGAL_DOCS.find((d) => d.slug === slug)!;

describe("the legal pages", () => {
  it("are privacy, cookies and terms, each with sections that have unique ids", () => {
    expect(LEGAL_DOCS.map((d) => d.slug)).toEqual(["privacy", "cookies", "terms"]);
    for (const doc of LEGAL_DOCS) {
      const ids = doc.sections.map((s) => s.id);
      expect(new Set(ids).size, doc.slug).toBe(ids.length);
    }
  });

  it("render with the top bar, a table of contents, the contact address and links to the other two", () => {
    for (const doc of LEGAL_DOCS) {
      const html = renderLegalPage(doc, { repo, themeToggle: "<button data-theme-toggle></button>" });
      expect(html).toContain(`<title>${doc.title} · ASafariM OS</title>`);
      expect(html).toContain(`<link rel="canonical" href="https://asafarim.site/${doc.slug}" />`);
      expect(html).toContain('id="account"');
      expect(html).toContain("data-theme-toggle");
      for (const s of doc.sections) expect(html).toContain(`<a href="#${s.id}">`);
      expect(html).toContain(CONTACT_EMAIL);
      for (const other of LEGAL_DOCS) expect(html).toContain(`<a href="/${other.slug}">`);
      // The CSP allows no inline script or style.
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html).not.toMatch(/\sstyle="/);
    }
  });

  it("render the cookie table so it stacks on a phone, every cell labelled", () => {
    const html = renderLegalPage(docOf("cookies"), { repo });
    expect(html).toContain('class="os-table os-table--stack"');
    expect(html).toContain('<td data-label="How long">');
  });

  // The cookie policy is an inventory: when the code sets a new cookie, this fails until the policy lists it.
  it("list every cookie the OS's code sets", () => {
    const text = JSON.stringify(docOf("cookies"));
    const names = [
      /var COOKIE = "([^"]+)"/.exec(source("packages/theme/theme.js"))?.[1],
      /SESSION_COOKIE_NAME = "([^"]+)"/.exec(source("packages/app-sdk/src/auth.ts"))?.[1],
      /ACCESS_COOKIE_NAME = "([^"]+)"/.exec(source("packages/registry-protocol/src/access-token.ts"))?.[1],
      /AUTH_COOKIE = "([^"]+)"/.exec(source("core/identity/src/sign-in.ts"))?.[1],
      /FLOW_COOKIE = "([^"]+)"/.exec(source("core/identity/src/sign-in.ts"))?.[1],
      /COMPLETION_COOKIE = "([^"]+)"/.exec(source("core/identity/src/provider.ts"))?.[1],
      // oidc-provider's and Auth.js's own names (their defaults; the code doesn't rename them).
      "_session",
      "_interaction",
      "_interaction_resume",
      "authjs.csrf-token",
      "authjs.callback-url",
      "authjs.state",
    ];
    for (const name of names) {
      expect(name, "a cookie constant moved: update this test").toBeTruthy();
      expect(text, `${name} is missing from the cookie policy`).toContain(name!);
    }
  });
});
