import { expect, test } from "@playwright/test";

/**
 * A guest takes the published course from start to finish (#358): the outline, each lesson at the revision the
 * course pinned, the contextual navigation, the article's canonical URL, and a lesson whose article was withdrawn
 * hidden everywhere. Seeded by e2e/seed.ts.
 */
test("a guest follows a course from the list to its last lesson", async ({ page }) => {
  await page.goto("/courses");
  const card = page.getByTestId("course-card");
  await expect(card).toHaveCount(1);
  // Three lessons: the fourth one's article was withdrawn after the course was published.
  await expect(card).toContainText("3 lessons");
  await card.getByRole("link", { name: "Ship a web app" }).click();

  await expect(page.getByTestId("course-title")).toHaveText("Ship a web app");
  await expect(page.getByTestId("outline-lesson")).toHaveText(["Plan the app", "Build the API", "Deploy it"]);
  await expect(page.getByText("Bonus: tuning")).toHaveCount(0);

  await page.getByTestId("start").click();
  const lesson = page.getByTestId("lesson");
  // The pinned revision, not the newer draft of the same article.
  await expect(lesson.getByRole("heading", { level: 1 })).toHaveText("Plan the app");
  await expect(lesson).toContainText("Write down what the app must do.");
  await expect(page.getByText("A draft nobody may see yet.")).toHaveCount(0);
  await expect(page.getByTestId("lesson-context")).toHaveText("Ship a web app · Design");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/articles\/plan-the-app$/);
  await expect(page.getByTestId("prev")).toHaveCount(0);

  await page.getByTestId("next").click();
  await expect(lesson.getByRole("heading", { level: 1 })).toHaveText("Build the API");
  await expect(page.getByTestId("lesson-context")).toHaveText("Ship a web app · Delivery");
  await page.getByTestId("next").click();
  await expect(lesson.getByRole("heading", { level: 1 })).toHaveText("Deploy it");
  // The last visible lesson: the withdrawn one after it isn't offered.
  await expect(page.getByTestId("next")).toHaveCount(0);
  await expect(page.getByTestId("prev")).toHaveText("← Build the API");
  await page.getByTestId("finish").click();
  await expect(page).toHaveURL(/\/courses\/ship-a-web-app$/);

  // The lesson's article keeps its own address.
  await page.goto("/articles/deploy-it");
  await expect(page.getByTestId("article")).toContainText("Ship the container to the server.");
});

test("an unknown course or lesson is not found", async ({ page }) => {
  expect((await page.goto("/courses/no-such-course"))?.status()).toBe(404);
  expect((await page.goto("/courses/ship-a-web-app/lessons/00000000-0000-4000-8000-000000000000"))?.status()).toBe(404);
});
