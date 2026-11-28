import { expect, test, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";

/**
 * A signed-in learner takes a course's assessment: a guest is asked to sign in; the learner answers three questions
 * (radio and checkboxes, a palette, review), submits, sees the graded result with explanations and per-lesson
 * scores, and the 3-day lock with the insights on the assessment page. Seeded by e2e/seed.ts. The session is a
 * signed Auth.js cookie (no identity stack runs in e2e). With KNOWLEDGE_E2E_SCREENSHOTS set to a folder, it saves the
 * runner, the result and the insights in light and dark, desktop and phone.
 */
const COOKIE = "__Host-asafarim.session-token";

async function signIn(page: Page, subject: string) {
  const value = await encode({
    token: { sub: subject, name: "Lena Learner", signedInAt: Math.floor(Date.now() / 1000) },
    secret: "knowledge-e2e-only-not-a-secret",
    salt: COOKIE,
  });
  await page
    .context()
    .addCookies([
      { name: COOKIE, value, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
}

const shots = process.env.KNOWLEDGE_E2E_SCREENSHOTS;
async function capture(page: Page, name: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    for (const [label, size] of [
      ["desktop", { width: 1200, height: 900 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(size);
      await page.screenshot({ path: `${shots}/${name}-${scheme}-${label}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("a learner takes a course assessment and sees where to study more", async ({ page }) => {
  await page.goto("/courses/ship-a-web-app");
  await page.getByTestId("assessment-link").click();
  await expect(page.getByTestId("assessment-sign-in")).toBeVisible();

  await signIn(page, "e2e-learner");
  await page.goto("/courses/ship-a-web-app/assessment");
  await expect(page.getByTestId("assessment-start")).toContainText("3");
  await page.getByTestId("start-attempt").click();
  await expect(page).toHaveURL(/\/assessment\/attempts\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("assessment-runner")).toBeVisible();
  // The browser never gets the answers.
  expect(await page.content()).not.toMatch(/"correct":true/);

  // Answer: the first option of each question (some will be wrong, as options are shuffled).
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("runner-option").first().click();
    if (i === 0) await capture(page, "runner");
    if (i < 2) await page.getByTestId("next-question").click();
  }
  await page.getByTestId("review-attempt").click();
  await expect(page.getByTestId("runner-review")).toContainText("You answered 3 of 3");
  await page.getByTestId("submit-attempt").click();

  await expect(page.getByTestId("attempt-result")).toBeVisible();
  await expect(page.getByTestId("result-question")).toHaveCount(3);
  await expect(page.getByTestId("attempt-lessons")).toBeVisible();
  await capture(page, "result");

  await page.goto("/courses/ship-a-web-app/assessment");
  await expect(page.getByTestId("retake-lock")).toContainText("Next attempt");
  await expect(page.getByTestId("assessment-insights")).toBeVisible();
  await expect(page.getByTestId("attempt-list").locator("li")).toHaveCount(1);
  await capture(page, "insights");
});
