/**
 * `pnpm --filter @asafarim/site build`: progress.json → dist/ (index.html, privacy.html, cookies.html, terms.html, theme.css, theme.js, styles.css,
 * session.js, favicon.svg, robots.txt, sitemap.xml, og.png and the screenshots the page uses), plus the app manifest's JSON Schema under /schemas/ (#87). Node built-ins
 * only: the image build runs this with no `pnpm install`.
 *
 * Every page is written in English (/, /privacy, …) and in Dutch, French and German (/nl/, /nl/privacy, …), with
 * @asafarim/locale's selector (selector.js, selector.css) to move between them.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProgress, type Progress } from "./progress.ts";
import { LEGAL_DOCS } from "./legal.ts";
import { localePath, SITE_LOCALES } from "./i18n.ts";
import { OG_IMAGE, pageUrl, renderLegalPage, renderPage, type ImageSize } from "./render.ts";

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

/**
 * The app manifest's JSON Schema, as @asafarim/app-manifest ships it (its own test keeps that file equal to
 * the Zod schema). Served at its `$id` and at a path versioned by the manifest's major version, so an
 * external app's tooling can pin `v1` while the unversioned URL follows the latest.
 */
export const MANIFEST_SCHEMA_MAJOR = 1;
export const MANIFEST_SCHEMA_PATHS = [
  "schemas/app-manifest.schema.json",
  `schemas/app-manifest/v${MANIFEST_SCHEMA_MAJOR}.json`,
] as const;
/**
 * @asafarim/theme (packages/theme): the shared tokens and top bar (theme.css), the light/dark script
 * (theme.js, which runs in <head> so the page never flashes the other theme) and the toggle's markup.
 * Read as files, from the same relative path in the repository and in the image build.
 */
export const defaultThemeDir = (siteDir: string) => path.join(siteDir, "..", "..", "packages", "theme");
/** @asafarim/locale (packages/locale): the country & language selector, bundled there once for every site and app. */
export const defaultLocaleDir = (siteDir: string) => path.join(siteDir, "..", "..", "packages", "locale");
/** Where the schema is, from core/site: the same relative path in the repository and in the image build. */
export const defaultSchemaFile = (siteDir: string) =>
  path.join(siteDir, "..", "..", "packages", "app-manifest", "schema", "app-manifest.schema.json");

/** The pages search engines should index: the home page and the legal pages, in every language (robots.txt points here). */
export function renderSitemap(): string {
  const pages = ["", ...LEGAL_DOCS.map((d) => d.slug)];
  const urls = SITE_LOCALES.flatMap((l) => pages.map((page) => pageUrl(l, page)));
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`;
}

export function loadProgress(file: string): Progress {
  return parseProgress(JSON.parse(readFileSync(file, "utf8")));
}

/** Build the site from `siteDir` (core/site) into `outDir`. Returns the files written, relative to outDir. */
export function buildSite(
  siteDir: string,
  outDir: string,
  opts: { schemaFile?: string; themeDir?: string; localeDir?: string } = {},
): string[] {
  const schemaFile = opts.schemaFile ?? defaultSchemaFile(siteDir);
  const themeDir = opts.themeDir ?? defaultThemeDir(siteDir);
  const localeDir = opts.localeDir ?? defaultLocaleDir(siteDir);
  const themeToggle = readFileSync(path.join(themeDir, "toggle.html"), "utf8");
  let schema: string;
  try {
    schema = readFileSync(schemaFile, "utf8");
  } catch {
    throw new Error(`the app manifest JSON Schema is missing at ${schemaFile}`);
  }
  const { $id } = JSON.parse(schema) as { $id?: unknown };
  if ($id !== `https://asafarim.site/${MANIFEST_SCHEMA_PATHS[0]}`) {
    throw new Error(`the manifest schema's $id is ${String($id)}, not the URL this site serves it at`);
  }

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
  mkdirSync(path.join(outDir, "schemas", "app-manifest"), { recursive: true });
  const written: string[] = [];
  const put = (name: string, from: string) => {
    copyFileSync(from, path.join(outDir, name));
    written.push(name);
  };

  const page = (name: string, html: string) => {
    mkdirSync(path.dirname(path.join(outDir, name)), { recursive: true });
    writeFileSync(path.join(outDir, name), html);
    written.push(name);
  };
  for (const locale of SITE_LOCALES) {
    // localePath: "/" or "/nl/" → "" or "nl/"
    const dir = localePath(locale).slice(1);
    page(`${dir}index.html`, renderPage(progress, { imageSizes, themeToggle, locale }));
    // The legal pages, at /privacy, /cookies and /terms (nginx tries `$uri.html`), and /nl/privacy, ….
    for (const doc of LEGAL_DOCS)
      page(`${dir}${doc.slug}.html`, renderLegalPage(doc, { repo: progress.repo, themeToggle, locale }));
  }
  put("theme.css", path.join(themeDir, "theme.css"));
  put("theme.js", path.join(themeDir, "theme.js"));
  put("selector.js", path.join(localeDir, "selector.js"));
  put("selector.css", path.join(localeDir, "selector.css"));
  put("styles.css", path.join(siteDir, "public", "styles.css"));
  put("favicon.svg", path.join(siteDir, "public", "favicon.svg"));
  put("robots.txt", path.join(siteDir, "public", "robots.txt"));
  put(OG_IMAGE.file, path.join(siteDir, "public", OG_IMAGE.file));
  writeFileSync(path.join(outDir, "sitemap.xml"), renderSitemap());
  written.push("sitemap.xml");
  put("session.js", path.join(siteDir, "public", "session.js"));
  // Only the screenshots the page uses: a stale PNG in public/ never ships.
  for (const file of imageSizes.keys()) put(`screenshots/${file}`, path.join(shotsDir, file));
  for (const name of MANIFEST_SCHEMA_PATHS) {
    writeFileSync(path.join(outDir, name), schema);
    written.push(name);
  }
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
