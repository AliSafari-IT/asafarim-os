/**
 * The reader (#80), end to end in a real browser against the real stack (identity, the dev login
 * stub, core-api), reading the made-up fixtures (DOCS_SOURCE_DIR, set by `pnpm e2e`):
 *
 *   docs active, docs.owner granted to dev-member → the roadmap fixture renders (table, task list,
 *   highlighted code, a drawn Mermaid chart, the image through /api/files, links inside the listing,
 *   a dead link as text) → "On this page", the filter, ⌘K search and a relative link all open the
 *   right place → on a phone the documents are a drawer → the home page's cards and previous / next →
 *   Lighthouse accessibility ≥ 95, light and dark, on the roadmap and on the home page.
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

test("the home page: a start card, one card per section, and previous / next under a document", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  const home = page.getByTestId("home");
  await expect(home.getByRole("heading", { level: 1 })).toHaveText("Welcome");
  await expect(home.getByTestId("home-start")).toContainText("Start here");
  // The fixtures' two folders with documents; the images folder has none, so it gets no card.
  const sections = home.getByTestId("home-sections");
  await expect(sections.getByRole("heading", { level: 2 })).toHaveText([/^Guides/, /^Ventures/]);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/docs-home-light.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/docs-home-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });

  // The roadmap, from its card: then "Next" follows the sidebar's order.
  await sections.getByRole("link", { name: /Roadmap$/ }).click();
  await expect(page.getByTestId("doc-title")).toHaveText("Demo app roadmap");
  await expect(page.getByTestId("pager-prev")).toContainText("Previous");
  await expect(page.getByTestId("pager-next")).toContainText("Overview");
  await page.getByTestId("pager-next").click();
  await expect(page.getByTestId("doc-title")).toHaveText("Demo app overview");
});

test("the app switcher in the top bar lists the OS apps this person can open, Docs marked current", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  const button = page.getByRole("button", { name: "Docs: switch app" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("navigation", { name: "Your apps" })).toHaveCount(0);

  await button.click();
  const menu = page.getByRole("navigation", { name: "Your apps" });
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const docs = menu.getByTestId("app-switcher-docs");
  await expect(docs).toHaveAttribute("aria-current", "page");
  await expect(docs).toHaveAttribute("href", /^https?:\/\//);
  for (const href of await menu.getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
    expect(href, "every item is an http(s) link to its app").toMatch(/^https?:\/\//);
  }
  // The way back to the OS homepage, at the foot.
  await expect(menu.getByTestId("app-switcher-home")).toHaveAttribute("href", "https://asafarim.site/");
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/docs-app-switcher.png` });

  // A click outside closes it.
  await page.getByTestId("home").getByRole("heading", { level: 1 }).click();
  await expect(menu).toHaveCount(0);

  // Keyboard: ArrowDown opens on the first app, Escape closes and gives focus back to the button.
  await button.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("navigation", { name: "Your apps" }).getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Your apps" })).toHaveCount(0);
  await expect(button).toBeFocused();
  // Enter opens on the first app too.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Your apps" }).getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Escape");
});

test("the account menu shows the person (never an id), links to the account and OS home, and signs out", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  const avatar = page.getByTestId("who").getByRole("button", { name: /^Your account menu: / });
  await expect(avatar).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("who")).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);

  await avatar.click();
  const name = page.getByTestId("user-menu-name");
  await expect(name).toBeVisible();
  await expect(name).not.toHaveText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  await expect(page.getByTestId("user-menu-account")).toHaveAttribute("href", /\/account$/);
  await expect(page.getByTestId("user-menu-home")).toHaveAttribute("href", "https://asafarim.site/");
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/docs-user-menu.png` });

  // Escape closes it and gives focus back to the avatar.
  await page.keyboard.press("Escape");
  await expect(name).toHaveCount(0);
  await expect(avatar).toBeFocused();

  // Signing out ends identity's session too (#252): identity asks first, then sends the browser back to
  // Docs (its registered post_logout_redirect_uri), signed out.
  await avatar.click();
  await page.getByTestId("sign-out").click();
  await expect(page.getByRole("heading", { name: "Sign out of ASafariM?" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("Lighthouse accessibility is at least 95, light and dark", async () => {
  const results = [await accessibilityScore("light"), await accessibilityScore("dark")];
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/lighthouse.json", `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results)
    console.log(`Lighthouse accessibility (${r.scheme}): ${Math.round(r.score * 100)}`, r.failing);
  for (const r of results) expect(r.score, `${r.scheme}: ${r.failing.join("; ")}`).toBeGreaterThanOrEqual(MIN_A11Y);
});

test("Lighthouse accessibility is at least 95 on the home page, light and dark", async () => {
  const results = [await accessibilityScore("light", "/"), await accessibilityScore("dark", "/")];
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/lighthouse-home.json", `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results)
    console.log(`Lighthouse accessibility, home (${r.scheme}): ${Math.round(r.score * 100)}`, r.failing);
  for (const r of results) expect(r.score, `${r.scheme}: ${r.failing.join("; ")}`).toBeGreaterThanOrEqual(MIN_A11Y);
});
