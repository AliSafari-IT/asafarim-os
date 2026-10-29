/**
 * Smoke test of the built asafarim.site page (asafarim-os#70): the sections render from the progress
 * file, every link goes to an allowed host, the screenshots load, nothing logs an error, and the page
 * works at phone width. Against the os-site container (SITE_EXPECT_HEADERS=1) it also checks the
 * security headers the container sends.
 */
import { expect, test, type Page } from "@playwright/test";
import { ALLOWED_LINK_HOSTS } from "../src/progress.ts";

/**
 * Identity's /whoami, answered here (the test has no identity): signed out unless a test says otherwise,
 * with the CORS headers identity sends to this site.
 */
async function whoami(page: Page, me: object = { signedIn: false }) {
  await page.route("https://id.asafarim.site/whoami", (route) =>
    route.fulfill({
      json: me,
      headers: {
        "access-control-allow-origin": route.request().headers()["origin"] ?? "",
        "access-control-allow-credentials": "true",
        vary: "Origin",
      },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await whoami(page);
});

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
    // The footer's privacy contact.
    if (url.protocol === "mailto:") {
      expect(url.pathname, href).toBe("privacy@asafarim.site");
      continue;
    }
    expect(url.protocol, href).toBe("https:");
    expect(ALLOWED_LINK_HOSTS, href).toContain(url.hostname);
  }
});

test("the top bar links to sign-in, Docs, Flow, Breinhap and IGS-Pharma", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Breinhap" })).toHaveAttribute(
    "href",
    "https://breinhap.asafarim.site/en/",
  );
  await expect(nav.getByRole("link", { name: "IGS-Pharma" })).toHaveAttribute("href", "https://igs.asafarim.site/en/");
  await expect(nav.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://docs.asafarim.site/");
  await expect(nav.getByRole("link", { name: "Flow" })).toHaveAttribute("href", "https://flow.asafarim.site/");
  await expect(nav.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "https://id.asafarim.site/login");
});

test("signed in, the top bar shows the person's avatar and menu instead of Sign in", async ({ page }) => {
  const errors = collectErrors(page);
  await page.unroute("https://id.asafarim.site/whoami");
  await whoami(page, { signedIn: true, label: "ali@example.test", initials: "AL", connected: true });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  const avatar = nav.getByRole("button", { name: "Your account menu: ali@example.test" });
  await expect(avatar).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await expect(page.locator("#access")).toContainText("signed in as ali@example.test");
  await expect(page.locator("#access").getByRole("link", { name: "Open Flow" })).toHaveAttribute(
    "href",
    "https://flow.asafarim.site/",
  );

  await avatar.click();
  await expect(page.getByTestId("user-name")).toHaveText("ali@example.test");
  await expect(page.getByTestId("user-docs")).toHaveAttribute("href", "https://docs.asafarim.site/");
  await expect(page.getByTestId("user-flow")).toHaveAttribute("href", "https://flow.asafarim.site/");
  await expect(page.getByTestId("user-account")).toHaveAttribute("href", "https://id.asafarim.site/account");
  // Not an admin: no Admin console.
  await expect(page.getByTestId("user-admin")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("user-name")).toBeHidden();

  // The keyboard opens it on the first item.
  await avatar.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-docs")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("user-flow")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("user-account")).toBeFocused();
  // A click outside closes it.
  await page.getByRole("heading", { level: 1 }).click();
  await expect(page.getByTestId("user-name")).toBeHidden();
  expect(errors).toEqual([]);
});

test("signed in as an admin, the menu also offers the Admin console", async ({ page }) => {
  const errors = collectErrors(page);
  await page.unroute("https://id.asafarim.site/whoami");
  await whoami(page, { signedIn: true, label: "ali@example.test", initials: "AL", connected: true, admin: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Your account menu: ali@example.test" }).click();
  await expect(page.getByTestId("user-admin")).toHaveAttribute("href", "https://admin.asafarim.site/");
  await expect(page.getByTestId("user-admin")).toHaveText("Admin console");
  expect(errors).toEqual([]);
});

test("signed out (or identity unreachable), the page keeps its Sign in link", async ({ page }) => {
  await page.unroute("https://id.asafarim.site/whoami");
  await page.route("https://id.asafarim.site/whoami", (route) => route.abort());
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByTestId("user")).toHaveCount(0);
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

test("the app manifest JSON Schema is served at its $id and at the versioned path (#87)", async ({ request }) => {
  const bodies: string[] = [];
  for (const path of ["/schemas/app-manifest.schema.json", "/schemas/app-manifest/v1.json"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toMatch(/^application\/schema\+json/);
    if (process.env.SITE_EXPECT_HEADERS === "1") expect(res.headers()["cache-control"], path).toMatch(/max-age=\d+/);
    bodies.push(await res.text());
  }
  expect(bodies[1]).toBe(bodies[0]);
  const schema = JSON.parse(bodies[0]!) as { $id: string; title: string };
  expect(schema.$id).toBe("https://asafarim.site/schemas/app-manifest.schema.json");
  expect(schema.title).toBe("ASafariM OS app manifest");
});

test("the container sends the security headers", async ({ request }) => {
  test.skip(process.env.SITE_EXPECT_HEADERS !== "1", "only against the os-site container");
  for (const path of ["/", "/styles.css", "/does-not-exist", "/schemas/app-manifest.schema.json"]) {
    const res = await request.get(path);
    const headers = res.headers();
    expect(headers["strict-transport-security"], path).toMatch(/max-age=\d+/);
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    const csp = headers["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'none'");
    expect(csp, path).toContain("script-src 'self'");
    expect(csp, path).toContain("connect-src https://id.asafarim.site");
    expect(csp, path).toContain("frame-ancestors 'none'");
  }
});

test("the privacy, cookie and terms pages load from the footer and fit a phone", async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const [link, heading] of [
    ["Privacy", "Privacy policy"],
    ["Cookies", "Cookie policy"],
    ["Terms", "Terms of use"],
  ] as const) {
    await page.locator("footer").getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.locator("footer")).toContainText("privacy@asafarim.site");
    if (link === "Cookies") await expect(page.locator("table.os-table--stack tbody tr").first()).toBeVisible();
    // No sideways scrolling, the cookie table included (its rows stack into cards).
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  expect(errors).toEqual([]);
});
