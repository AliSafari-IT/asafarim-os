/**
 * Smoke test of the built asafarim.site page (asafarim-os#70): the sections render from the progress
 * file, every link goes to an allowed host, the screenshots load, nothing logs an error, and the page
 * works at phone width. Against the os-site container (SITE_EXPECT_HEADERS=1) it also checks the
 * security headers the container sends.
 */
import { expect, test, type Page } from "@playwright/test";
import { ALLOWED_LINK_HOSTS } from "../src/progress.ts";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("requestfailed", (req) => errors.push(`${req.url()} ${req.failure()?.errorText}`));
  page.on("response", (res) => res.status() >= 400 && errors.push(`${res.url()} ${res.status()}`));
  return errors;
}

test("the page has its sections, a title and a description, and no console errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page).toHaveTitle(/ASafariM OS/);
  expect(await page.locator('meta[name="description"]').getAttribute("content")).toMatch(/apps plug into/);
  await expect(page.getByRole("heading", { level: 1, name: "ASafariM OS" })).toBeVisible();
  for (const name of ["Shipped", "Screenshots", "Roadmap"]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  await expect(page.locator("#shipped li.milestone").first()).toBeVisible();
  await expect(page.locator("#roadmap li")).toHaveCount(3);
  await expect(page.locator("body")).not.toContainText(/migrating|until (its|the) apps migrate/i);
  // Every screenshot has alt text and actually loads.
  const images = page.locator("img");
  expect(await images.count()).toBeGreaterThan(0);
  for (const img of await images.all()) {
    await img.scrollIntoViewIfNeeded();
    expect(await img.getAttribute("alt")).toBeTruthy();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("every link goes to this site or an allowed host, over https", async ({ page, baseURL }) => {
  await page.goto("/");
  const hrefs = await page
    .locator("a[href], link[href], img[src]")
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href || (el as HTMLImageElement).src));
  expect(hrefs.length).toBeGreaterThan(5);
  const self = new URL(baseURL!).host;
  for (const href of hrefs) {
    const url = new URL(href);
    // This page itself: relative URLs, and the canonical https://asafarim.site/.
    if (url.host === self || href === "https://asafarim.site/") continue;
    expect(url.protocol, href).toBe("https:");
    expect(ALLOWED_LINK_HOSTS, href).toContain(url.hostname);
  }
});

test("works at phone width: no horizontal scroll, images fit", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const img of await page.locator("img").all()) {
    expect((await img.boundingBox())!.width).toBeLessThanOrEqual(375);
  }
});

test("the container sends the security headers", async ({ request }) => {
  test.skip(process.env.SITE_EXPECT_HEADERS !== "1", "only against the os-site container");
  for (const path of ["/", "/styles.css", "/does-not-exist"]) {
    const res = await request.get(path);
    const headers = res.headers();
    expect(headers["strict-transport-security"], path).toMatch(/max-age=\d+/);
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    const csp = headers["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'none'");
    expect(csp, path).toContain("script-src 'none'");
    expect(csp, path).toContain("frame-ancestors 'none'");
  }
});
