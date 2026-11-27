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
  await expect(page.getByTestId("outline-lesson-title")).toHaveText(["Plan the app", "Build the API", "Deploy it"]);
  await expect(page.getByTestId("module-title")).toHaveText(["Design", "Delivery"]);
  await expect(page.getByTestId("course-facts")).toContainText("2 modules");
  await expect(page.getByTestId("course-facts")).toContainText("3 lessons");
  await expect(page.getByText("Bonus: tuning")).toHaveCount(0);
  // A fresh learner: one obvious first step, the first lesson flagged as next.
  await expect(page.getByTestId("start")).toContainText("Start the course");
  await expect(page.getByTestId("cta-next")).toHaveText("First up: Lesson 1 · Plan the app");
  await expect(page.getByTestId("progress-text")).toHaveText("0 of 3 lessons opened");
  await expect(page.getByTestId("lesson-marker").first()).toHaveAttribute("data-status", "next");

  await page.getByTestId("start").click();
  const lesson = page.getByTestId("lesson");
  // The pinned revision, not the newer draft of the same article.
  await expect(lesson.getByRole("heading", { level: 1 })).toHaveText("Plan the app");
  await expect(lesson).toContainText("Write down what the app must do.");
  await expect(page.getByText("A draft nobody may see yet.")).toHaveCount(0);
  await expect(page.getByTestId("lesson-context")).toHaveText("Ship a web app›Module 1: Design");
  await expect(page.getByTestId("lesson-step")).toHaveText("Lesson 1 of 3");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/articles\/plan-the-app$/);
  await expect(page.getByTestId("prev")).toHaveCount(0);
  await expect(page.getByTestId("next")).toContainText("Build the API");

  // Back on the course page, the learner continues where they left off.
  await page.goto("/courses/ship-a-web-app");
  await expect(page.getByTestId("start")).toContainText("Continue");
  await expect(page.getByTestId("cta-next")).toHaveText("Next: Lesson 2 · Build the API");
  await expect(page.getByTestId("progress-text")).toHaveText("1 of 3 lessons opened");
  await expect(page.getByTestId("lesson-marker").nth(0)).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("lesson-marker").nth(1)).toHaveAttribute("data-status", "next");
  await page.getByTestId("start").click();
  await expect(lesson.getByRole("heading", { level: 1 })).toHaveText("Build the API");
  await expect(page.getByTestId("lesson-context")).toHaveText("Ship a web app›Module 2: Delivery");
  await expect(page.getByTestId("lesson-step")).toHaveText("Lesson 2 of 3");
  await page.getByTestId("next").click();
  await expect(lesson.getByRole("heading", { level: 1 })).toHaveText("Deploy it");
  // The last visible lesson: the withdrawn one after it isn't offered.
  await expect(page.getByTestId("next")).toHaveCount(0);
  await expect(page.getByTestId("prev")).toContainText("Build the API");
  await page.getByTestId("finish").click();
  await expect(page).toHaveURL(/\/courses\/ship-a-web-app$/);
  await expect(page.getByTestId("progress-text")).toHaveText("3 of 3 lessons opened");
  await expect(page.getByTestId("start")).toContainText("Review from the start");

  // The lesson's article keeps its own address.
  await page.goto("/articles/deploy-it");
  await expect(page.getByTestId("article")).toContainText("Ship the container to the server.");
});

test("an unknown course or lesson is not found", async ({ page }) => {
  expect((await page.goto("/courses/no-such-course"))?.status()).toBe(404);
  expect((await page.goto("/courses/ship-a-web-app/lessons/00000000-0000-4000-8000-000000000000"))?.status()).toBe(404);
});

test("a guest likes a lesson, sees it counted on the course, and is asked to sign in to comment", async ({ page }) => {
  await page.goto("/courses/ship-a-web-app");
  await page.getByTestId("start").click();
  const like = page.getByTestId("like-button");
  await expect(like).toHaveAttribute("aria-pressed", "false");
  await like.click();
  await expect(like).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("like-count")).toHaveText("1");
  // Comments are public to read; writing one needs an account.
  await expect(page.getByTestId("comments-empty")).toBeVisible();
  await expect(page.getByTestId("comment-sign-in-button")).toBeVisible();
  await expect(page.getByTestId("comment-form")).toHaveCount(0);

  // The like survives a reload (the server remembers this guest) and rolls up to the course.
  await page.reload();
  await expect(page.getByTestId("like-button")).toHaveAttribute("aria-pressed", "true");
  await page.goto("/courses/ship-a-web-app");
  await expect(page.getByTestId("course-engagement")).toContainText("♥ 1");

  // The homepage article sees the lesson like. Undo there, then revisit the lesson.
  await page.goto("/");
  await page.getByRole("link", { name: "Plan the app", exact: true }).click();
  await expect(like).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("comments-empty")).toBeVisible();
  await like.click();
  await expect(like).toHaveAttribute("aria-pressed", "false");
  await page.goto("/courses/ship-a-web-app");
  await page.getByTestId("start").click();
  await expect(like).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("like-count")).toHaveText("0");
});
