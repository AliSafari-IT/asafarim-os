import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LEGAL_LINKS, parseTheme, PRIVACY_EMAIL, THEME_COOKIE, themeFromCookieHeader } from "../src/index.ts";
import { LegalFooter, ThemeToggle } from "../src/react.tsx";

const file = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const css = file("theme.css");
const script = file("theme.js");
const toggleHtml = file("toggle.html").trim();

/** Just enough of a browser to run theme.js: <html>, cookies, one toggle, click and media listeners. */
function browser(opts: { cookie?: string; dataTheme?: string; systemDark?: boolean; host?: string; https?: boolean }) {
  const attrs = new Map<string, string>(opts.dataTheme ? [["data-theme", opts.dataTheme]] : []);
  const root = {
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    hasAttribute: (k: string) => attrs.has(k),
  };
  const toggleAttrs = new Map<string, string>();
  const toggle = { setAttribute: (k: string, v: string) => void toggleAttrs.set(k, v), closest: () => toggle };
  const writes: string[] = [];
  let onClick: ((e: unknown) => void) | undefined;
  const document = {
    documentElement: root,
    readyState: "complete",
    get cookie() {
      return opts.cookie ?? "";
    },
    set cookie(v: string) {
      writes.push(v);
    },
    querySelectorAll: () => [toggle],
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "click") onClick = fn;
    },
  };
  const window: Record<string, unknown> = {
    matchMedia: () => ({ matches: !!opts.systemDark, addEventListener: () => {} }),
  };
  const location = {
    hostname: opts.host ?? "admin.asafarim.site",
    protocol: opts.https === false ? "http:" : "https:",
  };
  new Function("window", "document", "location", script)(window, document, location);
  const api = window.asafarimTheme as { current(): string; cookieDomain(h: string): string };
  return {
    api,
    theme: () => attrs.get("data-theme"),
    pressed: () => toggleAttrs.get("aria-pressed"),
    click: () => onClick?.({ target: toggle }),
    writes,
  };
}

describe("the theme tokens", () => {
  it("the system-dark block and the picked-dark block hold the same values", () => {
    const block = (start: string) => {
      const from = css.indexOf(start);
      const body = css.slice(css.indexOf("{", from + start.length - 1) + 1, css.indexOf("}", from));
      return body.replace(/\s+/g, " ").trim();
    };
    expect(block(':root:not([data-theme="light"]) {')).toBe(block(':root[data-theme="dark"] {'));
  });

  it("defines the shared tokens and the top bar", () => {
    for (const token of [
      "--bg",
      "--card",
      "--ink",
      "--muted",
      "--line",
      "--accent",
      "--accent-ink",
      "--top-bg",
      "--brand-a",
    ]) {
      expect(css).toContain(`${token}:`);
    }
    expect(css).toContain(".os-topbar {");
    // Tables: their own scroll, cards on a phone (labels from data-label), one-line ids and JSON.
    for (const rule of [
      ".os-table-wrap {",
      ".os-table {",
      ".os-id {",
      ".os-json summary {",
      "content: attr(data-label);",
    ])
      expect(css).toContain(rule);
    expect(css).toMatch(/@media \(max-width: 720px\) \{\s*\.os-table--stack thead/);
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("the toggle's markup", () => {
  it("the React toggle draws the same button as toggle.html", () => {
    const react = renderToStaticMarkup(createElement(ThemeToggle));
    for (const part of [
      'class="os-theme-toggle"',
      "data-theme-toggle",
      'aria-label="Dark theme"',
      'aria-pressed="false"',
      'data-testid="theme-toggle"',
      'mask="url(#os-theme-moon)"',
    ]) {
      expect(react).toContain(part);
      expect(toggleHtml).toContain(part);
    }
    const d = (html: string) => / d="([^"]+)"/.exec(html)?.[1];
    expect(d(react)).toBe(d(toggleHtml));
  });
});

describe("theme.js", () => {
  it("applies a remembered choice, unless the server already set one", () => {
    expect(browser({ cookie: "a=1; asafarim-theme=dark" }).theme()).toBe("dark");
    expect(browser({ cookie: "asafarim-theme=dark", dataTheme: "light" }).theme()).toBe("light");
    expect(browser({ cookie: "asafarim-theme=purple" }).theme()).toBeUndefined();
  });

  it("with no choice it follows the system, and the toggle says so", () => {
    const b = browser({ systemDark: true });
    expect(b.theme()).toBeUndefined();
    expect(b.api.current()).toBe("dark");
    expect(b.pressed()).toBe("true");
  });

  it("a click flips the theme and remembers it on the parent domain", () => {
    const b = browser({ systemDark: false });
    expect(b.pressed()).toBe("false");
    b.click();
    expect(b.theme()).toBe("dark");
    expect(b.pressed()).toBe("true");
    expect(b.writes.at(-1)).toBe(
      "asafarim-theme=dark; path=/; max-age=31536000; samesite=lax; domain=asafarim.site; secure",
    );
    b.click();
    expect(b.theme()).toBe("light");
  });

  it("keeps the cookie on the host for localhost and IP addresses", () => {
    const { api } = browser({});
    expect(api.cookieDomain("id.asafarim.site")).toBe("asafarim.site");
    expect(api.cookieDomain("asafarim.site")).toBe("asafarim.site");
    for (const host of ["localhost", "core.localhost", "127.0.0.1", "::1"]) expect(api.cookieDomain(host)).toBe("");
    const local = browser({ host: "core.localhost", https: false });
    local.click();
    expect(local.writes.at(-1)).toBe("asafarim-theme=dark; path=/; max-age=31536000; samesite=lax");
  });
});

describe("reading the choice on a server", () => {
  it("takes light or dark from the cookie, nothing else", () => {
    expect(THEME_COOKIE).toBe("asafarim-theme");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("auto")).toBeUndefined();
    expect(themeFromCookieHeader("x=1; asafarim-theme=light; y=2")).toBe("light");
    expect(themeFromCookieHeader("asafarim-theme=evil")).toBeUndefined();
    expect(themeFromCookieHeader(undefined)).toBeUndefined();
  });
});

describe("the legal footer", () => {
  it("links the privacy, cookie and terms pages on asafarim.site and the privacy contact", () => {
    expect(LEGAL_LINKS.map((l) => l.href)).toEqual([
      "https://asafarim.site/privacy",
      "https://asafarim.site/cookies",
      "https://asafarim.site/terms",
    ]);
    const html = renderToStaticMarkup(createElement(LegalFooter, { app: "Docs" }));
    expect(html).toContain('<footer class="os-legal"');
    expect(html).toContain("Docs · ASafariM OS");
    for (const { href, label } of LEGAL_LINKS) expect(html).toContain(`<a href="${href}">${label}</a>`);
    expect(html).toContain(`href="mailto:${PRIVACY_EMAIL}"`);
  });
});
