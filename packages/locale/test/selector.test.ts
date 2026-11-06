import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTPUT, render, STYLES } from "../scripts/build-selector.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
};

describe("the bundled country & language selector", () => {
  it("is a fresh build of the pinned @asafarim/country-language-selector (run build:selector after an upgrade)", async () => {
    const built = await render();
    const pinned = pkg.devDependencies["@asafarim/country-language-selector"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(OUTPUT, "utf8")).toBe(built.js);
    expect(readFileSync(STYLES, "utf8")).toBe(built.css);
    expect(built.js).toContain(`@asafarim/country-language-selector ${pinned}`);
  }, 60_000);

  it("is self-contained: no network, no eval, nothing a `script-src 'self'` page would refuse", () => {
    const js = readFileSync(OUTPUT, "utf8");
    expect(/\beval\(|new Function\(|\bfetch\(|XMLHttpRequest|sendBeacon/.test(js)).toBe(false);
    // Only XML namespaces, React's error-decoder link and the flag CDN of the component's "image" flag mode,
    // which the selector does not use (it shows emoji flags): nothing is loaded from another origin.
    const origins = new Set([...js.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]));
    expect([...origins].sort()).toEqual(["http://www.w3.org", "https://flagcdn.com", "https://react.dev"]);
    expect(/mode:"image"|flagMode:"image"/.test(js)).toBe(false);
    expect(readFileSync(STYLES, "utf8")).not.toMatch(/@import|url\(\s*["']?https?:/i);
  });
});
