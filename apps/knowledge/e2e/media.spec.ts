import { expect, test } from "@playwright/test";

/**
 * A video in a published article (#359): nothing is loaded from the provider until the guest asks, then the player
 * comes from the privacy-enhanced address built from the stored id. Seeded by e2e/seed.ts.
 */
test("a guest loads an embedded video only on request", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  // The provider is never contacted for real in a test.
  const provider = /^https:\/\/(www\.)?youtube(-nocookie)?\.com\//;
  await page.route(provider, (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto("/articles/video-demo");
  const video = page.getByTestId("video");
  await expect(video).toContainText("The demo");
  await expect(video.locator("iframe")).toHaveCount(0);
  expect(requested.filter((u) => provider.test(u))).toEqual([]);

  await page.getByTestId("video-load").click();
  const frame = video.locator("iframe");
  await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
  await expect(frame).toHaveAttribute("title", "The demo");
  await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
});

test("an unknown or private media id is not found", async ({ page }) => {
  expect((await page.goto("/media/00000000-0000-4000-8000-000000000000"))?.status()).toBe(404);
  expect((await page.goto("/media/not-an-id"))?.status()).toBe(404);
});
