/**
 * `pnpm --filter @asafarim/site build`: progress.json → dist/ (index.html, styles.css, favicon.svg and the
 * screenshots the page uses). Node built-ins only: the image build runs this with no `pnpm install`.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProgress, type Progress } from "./progress.ts";
import { renderPage, type ImageSize } from "./render.ts";

/** Every screenshot the site ships stays under this size (the issue's budget). */
export const MAX_SCREENSHOT_BYTES = 300 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk. Throws if the bytes are not a PNG. */
export function pngSize(bytes: Buffer): ImageSize {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("not a PNG file");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function loadProgress(file: string): Progress {
  return parseProgress(JSON.parse(readFileSync(file, "utf8")));
}

/** Build the site from `siteDir` (core/site) into `outDir`. Returns the files written, relative to outDir. */
export function buildSite(siteDir: string, outDir: string): string[] {
  const progress = loadProgress(path.join(siteDir, "src", "progress.json"));
  const shotsDir = path.join(siteDir, "public", "screenshots");

  const imageSizes = new Map<string, ImageSize>();
  for (const { file } of progress.screenshots) {
    const source = path.join(shotsDir, file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(source);
    } catch {
      throw new Error(`screenshots/${file} is listed in progress.json but missing: run \`pnpm screenshots\``);
    }
    if (bytes.length > MAX_SCREENSHOT_BYTES) {
      throw new Error(`screenshots/${file} is ${Math.round(bytes.length / 1024)} KB; the budget is 300 KB`);
    }
    imageSizes.set(file, pngSize(bytes));
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "screenshots"), { recursive: true });
  const written: string[] = [];
  const put = (name: string, from: string) => {
    copyFileSync(from, path.join(outDir, name));
    written.push(name);
  };

  writeFileSync(path.join(outDir, "index.html"), renderPage(progress, { imageSizes }));
  written.push("index.html");
  put("styles.css", path.join(siteDir, "public", "styles.css"));
  put("favicon.svg", path.join(siteDir, "public", "favicon.svg"));
  put("robots.txt", path.join(siteDir, "public", "robots.txt"));
  // Only the screenshots the page uses: a stale PNG in public/ never ships.
  for (const file of imageSizes.keys()) put(`screenshots/${file}`, path.join(shotsDir, file));
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = path.join(siteDir, "dist");
  const written = buildSite(siteDir, outDir);
  const bytes = written.reduce((sum, f) => sum + statSync(path.join(outDir, f)).size, 0);
  console.log(
    `site: wrote ${written.length} files (${Math.round(bytes / 1024)} KB) to ${path.relative(process.cwd(), outDir) || "."}`,
  );
}
