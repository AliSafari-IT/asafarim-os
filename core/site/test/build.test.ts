import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SCREENSHOT_BYTES, buildSite, loadProgress, pngSize } from "../src/build.ts";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "site-build-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of core/site to break things in. */
function siteCopy() {
  const dir = temp();
  for (const part of ["src", "public"]) cpSync(path.join(siteDir, part), path.join(dir, part), { recursive: true });
  return dir;
}

describe("the checked-in screenshots", () => {
  const progress = loadProgress(path.join(siteDir, "src", "progress.json"));

  it("exist for every entry, are PNGs, and stay under 300 KB", () => {
    for (const { file } of progress.screenshots) {
      const bytes = readFileSync(path.join(siteDir, "public", "screenshots", file));
      expect(bytes.length, file).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES);
      const { width, height } = pngSize(bytes);
      expect(width, file).toBeGreaterThan(0);
      expect(height, file).toBeGreaterThan(0);
    }
  });

  it("are all used: no orphan PNG in public/screenshots", () => {
    const used = new Set(progress.screenshots.map((s) => s.file));
    const present = readdirSync(path.join(siteDir, "public", "screenshots")).filter((f) => f.endsWith(".png"));
    expect(present.filter((f) => !used.has(f))).toEqual([]);
  });
});

describe("buildSite", () => {
  it("writes the page, its stylesheet, icon and exactly the screenshots it uses", () => {
    const out = temp();
    const written = buildSite(siteDir, out);
    expect(written).toContain("index.html");
    expect(written).toContain("styles.css");
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    for (const [, src] of html.matchAll(/<img src="([^"]+)"/g)) expect(written).toContain(src);
  });

  it("refuses a listed screenshot that is missing", () => {
    const dir = siteCopy();
    const first = loadProgress(path.join(dir, "src", "progress.json")).screenshots[0]!.file;
    rmSync(path.join(dir, "public", "screenshots", first));
    expect(() => buildSite(dir, temp())).toThrow(/pnpm screenshots/);
  });

  it("refuses a screenshot over the 300 KB budget", () => {
    const dir = siteCopy();
    const first = loadProgress(path.join(dir, "src", "progress.json")).screenshots[0]!.file;
    const file = path.join(dir, "public", "screenshots", first);
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
    expect(() => buildSite(dir, temp())).toThrow(/300 KB/);
  });
});

describe("pngSize", () => {
  it("reads the IHDR size and refuses anything else", () => {
    const header = Buffer.from("89504e470d0a1a0a0000000d49484452000005000000032008060000", "hex");
    expect(pngSize(header)).toEqual({ width: 1280, height: 800 });
    expect(() => pngSize(Buffer.from("GIF89a................"))).toThrow(/not a PNG/);
  });
});
