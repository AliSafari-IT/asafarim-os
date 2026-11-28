import { expect, test, type Page } from "@playwright/test";

const card = (page: Page, title: string) => page.getByTestId("article-card").filter({ hasText: title });

test("a card whose article has an image shows it as a round thumbnail beside the text", async ({ page }) => {
  await page.goto("/");
  const pictured = card(page, "Picture post");
  const thumb = pictured.getByTestId("article-thumb");
  await expect(thumb).toBeVisible();
  // Decorative: the title link names the card.
  await expect(thumb).toHaveAttribute("alt", "");
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  const box = (await thumb.boundingBox())!;
  expect(Math.round(box.width)).toBe(96);
  expect(Math.round(box.height)).toBe(96);
  const style = await thumb.evaluate((img) => {
    const s = getComputedStyle(img);
    return { radius: s.borderRadius, fit: s.objectFit };
  });
  expect(style).toEqual({ radius: "50%", fit: "cover" });

  // Left of the title, vertically centred in the card (within the featured card's thicker top border).
  const title = (await pictured.getByRole("heading").boundingBox())!;
  expect(box.x + box.width).toBeLessThan(title.x);
  const li = (await pictured.boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (li.y + li.height / 2))).toBeLessThan(4);

  // The newest article keeps its "Latest" badge, and the card still opens the article.
  await expect(pictured.getByText("Latest")).toBeVisible();
  await pictured.getByRole("link", { name: "Picture post" }).click();
  await expect(page).toHaveURL(/\/articles\/picture-post$/);
});

test("a card without an image keeps the full-width text and no placeholder", async ({ page }) => {
  await page.goto("/");
  const plain = card(page, "Video demo");
  await expect(plain).toBeVisible();
  await expect(plain.getByTestId("article-thumb")).toHaveCount(0);
  await expect(plain).not.toHaveClass(/has-thumb/);
});

test("on a phone the thumbnail is smaller and nothing overflows", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const box = (await card(page, "Picture post").getByTestId("article-thumb").boundingBox())!;
  expect(Math.round(box.width)).toBe(64);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

const SHOTS = process.env.KNOWLEDGE_E2E_SCREENSHOTS;
test("home page screenshots", async ({ browser }) => {
  test.skip(!SHOTS, "set KNOWLEDGE_E2E_SCREENSHOTS to a folder to save screenshots");
  for (const scheme of ["light", "dark"] as const) {
    for (const [name, viewport] of [
      ["desktop", { width: 1200, height: 860 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto("/");
      await page.screenshot({ path: `${SHOTS}/home-${scheme}-${name}.png`, fullPage: true });
      await ctx.close();
    }
  }
});

test("on a phone the top bar's links fold into a menu that includes Assessments", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("assessments-nav")).toBeHidden();
  await page.getByTestId("nav-menu").locator("summary").click();
  await page.getByTestId("nav-menu").getByRole("link", { name: "Assessments" }).click();
  await expect(page).toHaveURL(/\/assessments$/);
});
