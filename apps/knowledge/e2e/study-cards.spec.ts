import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/** The seeded course's cover lives on another site; the browser gets this drawing instead of going online. */
const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#cfe3f1"/><stop offset="1" stop-color="#e8f1e4"/></linearGradient></defs>
<rect width="800" height="500" fill="url(#g)"/>
<rect x="140" y="150" width="420" height="270" rx="18" fill="#fff" stroke="#0f4c6e" stroke-width="6"/>
<rect x="140" y="150" width="420" height="44" rx="18" fill="#0f4c6e"/>
<circle cx="172" cy="172" r="7" fill="#fff"/><circle cx="196" cy="172" r="7" fill="#fff"/>
<path d="M600 90 l40 40 -90 120 -40 -40z" fill="#e07a5f"/><circle cx="600" cy="150" r="14" fill="#fff"/>
<path d="M520 250 l-30 60 50 -20z" fill="#f2cc8f"/>
<path d="M200 260h200M200 300h300M200 340h160" stroke="#9db4c3" stroke-width="14" stroke-linecap="round"/>
</svg>`;
async function fakeCover(target: Page | BrowserContext) {
  await target.route("https://images.example.org/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: COVER_SVG }),
  );
}

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
  await expect(card).toHaveAccessibleName(/^Question\s*What does a course lesson pin\?/);
  await expect(page.getByTestId("card-prev")).toBeDisabled();

  // Tap to flip, then "I knew it" marks it and moves on.
  await card.click();
  await expect(card).toHaveAttribute("data-side", "back");
  await expect(page.getByTestId("card-back")).toHaveText("One published revision of its article.");
  // Screen readers get the visible face as the card's name, and hear the answer when it flips.
  await expect(card).toHaveAccessibleName(/^Answer\s*One published revision of its article\./);
  await expect(page.getByTestId("card-announce")).toHaveText("Answer: One published revision of its article.");
  await page.getByTestId("mark-known").click();
  await expect(page.getByTestId("study-position")).toHaveText("Card 2 of 3");
  await expect(card).toHaveAttribute("data-side", "front");
  await expect(page.getByTestId("study-known")).toHaveText("1 of 3 known");
  // The tiles: a one-day streak (a card was flipped today), one card mastered, no lesson opened yet.
  await expect(page.getByTestId("stat-streak-value")).toHaveText("1 day");
  await expect(page.getByTestId("stat-mastered-value")).toHaveText("1 of 3");
  await expect(page.getByTestId("stat-course-value")).toHaveText("0%");

  // The keyboard: Space flips the focused card, arrows move.
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("data-side", "back");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("study-position")).toHaveText("Card 3 of 3");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("study-position")).toHaveText("Card 2 of 3");
  await page.getByTestId("card-next").click();
  // "Show answer" by keyboard: the button goes away, the keyboard stays on the card.
  await page.getByTestId("card-flip").focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveAttribute("data-side", "back");
  await expect(card).toBeFocused();
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

test("the course page shows its cover, the learner's tiles and the modules as cards", async ({ page }) => {
  await fakeCover(page);
  await page.goto("/courses/ship-a-web-app");
  await expect(page.getByTestId("course-cover")).toHaveAttribute("alt", "A rocket over a browser window");
  await expect(page.getByTestId("course-facts")).toContainText("across 2 modules");
  await expect(page.getByTestId("stat-streak-value")).toHaveText("0 days");
  await expect(page.getByTestId("stat-mastered-value")).toHaveText("0 of 3");
  await expect(page.getByTestId("stat-course-value")).toHaveText("0%");
  const tiles = page.getByTestId("module-tile");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toContainText("Module 01");
  await expect(tiles.nth(0)).toContainText("Design");
  await expect(tiles.nth(1)).toContainText("2 lessons");
  await expect(page.getByTestId("module-progress").nth(0)).toHaveText("0 of 1 opened");
  await tiles.nth(1).click();
  await expect(page).toHaveURL(/#module-2$/);
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
      await fakeCover(ctx);
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
