/**
 * The reader (#80), end to end in a real browser against the real stack (identity, the dev login
 * stub, core-api), reading the made-up fixtures (DOCS_SOURCE_DIR, set by `pnpm e2e`):
 *
 *   docs active, docs.owner granted to dev-member → the roadmap fixture renders (table, task list,
 *   highlighted code, a drawn Mermaid chart, the image through /api/files, links inside the listing,
 *   a dead link as text) → "On this page", the filter, ⌘K search and a relative link all open the
 *   right place → on a phone the documents are a drawer → Lighthouse accessibility ≥ 95, light and dark.
 *
 * Screenshots go to test-results/screens/ and the Lighthouse scores to test-results/lighthouse.json
 * (both uploaded by CI).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import lighthouse from "lighthouse";

const CORE_API = process.env.E2E_CORE_API_URL ?? "http://localhost:4020";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const BASE = process.env.E2E_DOCS_URL ?? "http://localhost:4110";
const SHOTS = "test-results/screens";
const ROADMAP = "ventures/demo-app/roadmap/roadmap.md";
const roadmapUrl = (hash = "") => `/?doc=${encodeURIComponent(ROADMAP)}${hash}`;
const MIN_A11Y = 0.95;

async function admin(method: string, p: string) {
  const res = await fetch(`${CORE_API}${p}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  return res.status;
}

/** Sign in through identity and the dev login stub as dev-member. */
async function signIn(page: Page) {
  await page.goto(`${BASE}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Dev Member/ }).click();
  await expect(page.getByTestId("who")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(ADMIN_TOKEN, "E2E_ADMIN_TOKEN must be set (pnpm e2e sets it)").not.toBe("");
  // 409 when it's already active: fine.
  expect([200, 409]).toContain(await admin("POST", "/admin/v1/apps/docs/activate"));
  expect(await admin("PUT", "/admin/v1/roles/docs.owner/grants/dev-member")).toBeLessThan(300);
  // The app caches a person's access for 1 s in development.
  await new Promise((resolve) => setTimeout(resolve, 1500));
});

test.afterAll(async () => {
  await admin("DELETE", "/admin/v1/roles/docs.owner/grants/dev-member");
  await admin("POST", "/admin/v1/apps/docs/deactivate");
});

test("the roadmap renders: table, tasks, code, Mermaid, the image and its links", async ({ page }) => {
  await signIn(page);
  await page.goto(roadmapUrl());
  await expect(page.getByTestId("doc-title")).toHaveText("Demo app roadmap");
  await expect(page.getByTestId("breadcrumb")).toHaveText(/Ventures.*Demo App.*Roadmap/);
  await expect(page.getByTestId("stats")).toHaveText(/\d+ min read · \d+ words/);
  await expect(page.locator("h1")).toHaveCount(1);

  const body = page.getByTestId("doc-body");
  await expect(body.getByRole("table")).toContainText("In progress");
  await expect(body.getByRole("checkbox", { checked: true })).toHaveCount(1);
  await expect(body.locator("pre.shiki code.language-ts")).toContainText("Hello, ${name}");
  // The `# comment` in the bash block is code, not a heading.
  await expect(body.getByRole("heading", { name: /install/ })).toHaveCount(0);

  const chart = body.getByTestId("mermaid");
  await expect(chart).toHaveAttribute("data-state", "drawn");
  await expect(chart.getByRole("img", { name: "Diagram: Demo app timeline" }).locator("svg")).toBeVisible();

  const image = body.getByRole("img", { name: "A made-up diagram of the demo app" });
  await expect(image).toHaveAttribute("src", "/api/files/images/diagram.svg");
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await expect(body.getByRole("link", { name: "example-org/demo-app#12" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(body.locator(".dead-link")).toHaveText("like this one");
  await expect(body.locator('a[href*="outside"]')).toHaveCount(0);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/docs-roadmap-light.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  // The chart is drawn again in the dark theme.
  await expect(chart).toHaveAttribute("data-state", "drawn");
  await page.screenshot({ path: `${SHOTS}/docs-roadmap-dark.png`, fullPage: true });
});

test("On this page, the filter, ⌘K search and links inside the documents", async ({ page }) => {
  await signIn(page);
  await page.goto(roadmapUrl());

  const toc = page.getByTestId("toc");
  await expect(toc.getByRole("link")).toHaveText(["Milestones", "Timeline", "Architecture", "Setup", "Tracking"]);
  await toc.getByRole("link", { name: "Setup" }).click();
  await expect(page).toHaveURL(/#setup$/);
  // The section linked to is marked, even when the page can't scroll it to the top.
  await expect(toc.locator('[aria-current="location"]')).toHaveText("Setup");

  await page.getByTestId("tree-filter").fill("roadm");
  await expect(page.locator("#documents").getByRole("link")).toHaveText(["Roadmap"]);
  await page.getByTestId("tree-filter").fill("nothing like this");
  await expect(page.getByTestId("tree-empty")).toHaveText("No document matches.");
  await page.getByTestId("tree-filter").fill("");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("search-input")).toBeFocused();
  await page.getByTestId("search-input").fill("timeline");
  await expect(page.getByTestId("search-results").getByRole("option").first()).toContainText("Timeline");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/doc=ventures%2Fdemo-app%2Froadmap%2Froadmap\.md#timeline$/);

  await page.getByTestId("doc-body").getByRole("link", { name: "Postgres decision" }).click();
  await expect(page.getByTestId("doc-title")).toHaveText("0001: Use Postgres");
  await expect(page).toHaveURL(/#decision$/);
});

test("on a phone the documents are a drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(roadmapUrl());
  const drawer = page.locator("#documents");
  await expect(drawer).toBeHidden();
  await page.getByTestId("drawer-toggle").click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.getByTestId("drawer-toggle").click();
  await page.getByTestId("doc-ventures/demo-app/overview.md").click();
  await expect(page.getByTestId("doc-title")).toHaveText("Demo app overview");
  await expect(drawer).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/docs-phone.png`, fullPage: true });
});

/**
 * Lighthouse (accessibility only) on the roadmap, signed in: Chromium is launched with a DevTools
 * port, signed in through Playwright, and Lighthouse opens the page in that same browser.
 */
async function accessibilityScore(scheme: "light" | "dark") {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "docs-lh-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Full Chromium (new headless), the browser Lighthouse is made for.
    channel: "chromium",
    args: ["--remote-debugging-port=0", ...(scheme === "dark" ? ["--force-dark-mode"] : [])],
    viewport: { width: 1350, height: 940 },
    // No emulated colour scheme: Lighthouse's tab has to see the browser's own.
    colorScheme: null,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await signIn(page);
    await page.goto(`${BASE}${roadmapUrl()}`);
    // The scheme Lighthouse will see is the browser's own, not an emulation of this page.
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(scheme === "dark");
    const port = Number(readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0]);
    const result = await lighthouse(
      `${BASE}${roadmapUrl()}`,
      { port, onlyCategories: ["accessibility"], disableStorageReset: true, logLevel: "error", output: "json" },
      {
        extends: "lighthouse:default",
        settings: { formFactor: "desktop", screenEmulation: { disabled: true }, throttlingMethod: "provided" },
      },
    );
    const lhr = result!.lhr;
    const failing = Object.values(lhr.audits)
      .filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode === "binary")
      .map((a) => `${a.id}: ${a.title}`);
    return { scheme, score: lhr.categories.accessibility!.score ?? 0, failing };
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

test("Lighthouse accessibility is at least 95, light and dark", async () => {
  const results = [await accessibilityScore("light"), await accessibilityScore("dark")];
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/lighthouse.json", `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results)
    console.log(`Lighthouse accessibility (${r.scheme}): ${Math.round(r.score * 100)}`, r.failing);
  for (const r of results) expect(r.score, `${r.scheme}: ${r.failing.join("; ")}`).toBeGreaterThanOrEqual(MIN_A11Y);
});
