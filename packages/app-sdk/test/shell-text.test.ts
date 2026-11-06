import { describe, expect, it } from "vitest";
import { osHomeHref, productHref, shellText, type ShellLocale } from "../src/shell-text.ts";

const LOCALES: ShellLocale[] = ["en", "nl", "fr", "de"];

describe("shell text in four languages", () => {
  it("every language has every word, none empty", () => {
    const en = shellText("en");
    for (const l of LOCALES) {
      const t = shellText(l);
      expect(Object.keys(t).sort(), l).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(t)) {
        const s = typeof v === "function" ? v("Docs") : v;
        expect(s.length, `${l}.${k}`).toBeGreaterThan(0);
      }
      expect(t.switchApp("Docs")).toContain("Docs");
    }
  });

  it("English is the default", () => {
    expect(shellText()).toBe(shellText("en"));
    expect(shellText().yourApps).toBe("Your apps");
    expect(osHomeHref()).toBe("https://asafarim.site/");
  });

  it("links follow the language", () => {
    expect(osHomeHref("fr")).toBe("https://asafarim.site/fr/");
    expect(productHref("igs", "de")).toBe("https://igs.asafarim.site/de/");
    expect(productHref("breinhap", "nl")).toBe("https://breinhap.asafarim.site/");
    expect(productHref("breinhap", "fr")).toBe("https://breinhap.asafarim.site/en/");
  });
});
