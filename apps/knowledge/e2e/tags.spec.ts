import { expect, test } from "@playwright/test";

test("discover the same tag from the homepage, article and lesson", async ({ page }) => {
  await page.goto("/");
  const tag = page.getByRole("link", { name: "Planning", exact: true });
  await tag.click();
  await expect(page).toHaveURL(/\/tags\/planning$/);
  await expect(page.getByRole("heading", { name: "Posts tagged “Planning”" })).toBeVisible();
  await expect(page.getByTestId("result")).toHaveCount(1);
  await page.getByRole("link", { name: "Plan the app" }).click();
  await expect(tag).toHaveAttribute("href", "/tags/planning");
  await expect(page.locator('meta[name="keywords"]')).toHaveAttribute("content", "Planning");
  await page.goto("/courses/ship-a-web-app");
  await page.getByTestId("start").click();
  await expect(tag).toHaveAttribute("href", "/tags/planning");
  expect((await page.goto("/tags/tuning"))?.status()).toBe(404);
});
