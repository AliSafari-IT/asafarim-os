import { expect, test } from "@playwright/test";

/**
 * A guest studies a course's flip cards: flip, mark, next / previous by button and keyboard, a review round of only
 * the cards still to learn, and marks kept across a reload. Seeded by e2e/seed.ts (three cards on "Ship a web app").
 * With KNOWLEDGE_E2E_SCREENSHOTS set to a folder, it also saves the study page in light and dark, desktop and phone.
 */
test("a guest studies a course's flip cards", async ({ page }) => {
  await page.goto("/courses/ship-a-web-app");
  await expect(page.getByTestId("course-facts")).toContainText("3 study cards");
  await page.getByTestId("study-link").click();
  await expect(page).toHaveURL(/\/courses\/ship-a-web-app\/cards$/);
  await expect(page.getByTestId("study-title")).toHaveText("Ship a web app");

  const card = page.getByTestId("flip-card");
  await expect(page.getByTestId("study-position")).toHaveText("Card 1 of 3");
  await expect(page.getByTestId("card-front")).toHaveText("What does a course lesson pin?");
  await expect(card).toHaveAttribute("data-side", "front");
  await expect(page.getByTestId("card-prev")).toBeDisabled();

  // Tap to flip, then "I knew it" marks it and moves on.
  await card.click();
  await expect(card).toHaveAttribute("data-side", "back");
  await expect(page.getByTestId("card-back")).toHaveText("One published revision of its article.");
  await page.getByTestId("mark-known").click();
  await expect(page.getByTestId("study-position")).toHaveText("Card 2 of 3");
  await expect(card).toHaveAttribute("data-side", "front");
  await expect(page.getByTestId("study-known")).toHaveText("1 of 3 known");

  // The keyboard: Space flips the focused card, arrows move.
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("data-side", "back");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("study-position")).toHaveText("Card 3 of 3");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("study-position")).toHaveText("Card 2 of 3");
  await page.getByTestId("card-next").click();
  await page.getByTestId("card-flip").click();
  await page.getByTestId("mark-learning").click();

  // The round ends; review goes through the two still to learn only.
  await expect(page.getByTestId("study-done")).toContainText("1 known · 2 still to learn");
  await page.getByTestId("review-again").click();
  await expect(page.getByTestId("study-position")).toHaveText("Card 1 of 2");
  await expect(page.getByTestId("card-front")).toHaveText("When do guests see a course change?");
  await expect(page.getByTestId("mode-review")).toHaveAttribute("aria-pressed", "true");

  // Marks survive a reload (this browser), and can be cleared.
  await page.reload();
  await expect(page.getByTestId("study-known")).toHaveText("1 of 3 known");
  await page.getByTestId("mode-all").click();
  for (let i = 0; i < 3; i++) await page.getByTestId("card-next").click();
  await page.getByTestId("reset-marks").click();
  await expect(page.getByTestId("study-known")).toHaveText("0 of 3 known");
  await expect(page.getByTestId("study-position")).toHaveText("Card 1 of 3");
});

test("a course without study cards has no study page", async ({ page }) => {
  expect((await page.goto("/courses/no-such-course/cards"))?.status()).toBe(404);
});

const SHOTS = process.env.KNOWLEDGE_E2E_SCREENSHOTS;
test("study page screenshots", async ({ browser }) => {
  test.skip(!SHOTS, "set KNOWLEDGE_E2E_SCREENSHOTS to a folder to save screenshots");
  for (const scheme of ["light", "dark"] as const) {
    for (const [name, viewport] of [
      ["desktop", { width: 1200, height: 860 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto("/courses/ship-a-web-app/cards");
      await page.screenshot({ path: `${SHOTS}/cards-front-${scheme}-${name}.png`, fullPage: true });
      await page.getByTestId("flip-card").click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SHOTS}/cards-back-${scheme}-${name}.png`, fullPage: true });
      await page.goto("/courses/ship-a-web-app");
      await page.screenshot({ path: `${SHOTS}/course-${scheme}-${name}.png`, fullPage: true });
      await ctx.close();
    }
  }
});
