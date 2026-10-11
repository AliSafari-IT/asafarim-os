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
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { accessibilityScore, grantOwner, MIN_A11Y, revokeOwner, roadmapUrl, SHOTS, signIn } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeAll(grantOwner);
test.afterAll(revokeOwner);

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
  // Focus moves into the drawer, and back to the button when it closes.
  await expect(page.getByTestId("tree-filter")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId("drawer-toggle")).toBeFocused();
  await page.getByTestId("drawer-toggle").click();
  await page.getByTestId("doc-ventures/demo-app/overview.md").click();
  await expect(page.getByTestId("doc-title")).toHaveText("Demo app overview");
  await expect(drawer).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/docs-phone.png`, fullPage: true });
});

test("Lighthouse accessibility is at least 95, light and dark", async () => {
  const results = [await accessibilityScore("light"), await accessibilityScore("dark")];
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/lighthouse.json", `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results)
    console.log(`Lighthouse accessibility (${r.scheme}): ${Math.round(r.score * 100)}`, r.failing);
  for (const r of results) expect(r.score, `${r.scheme}: ${r.failing.join("; ")}`).toBeGreaterThanOrEqual(MIN_A11Y);
});
