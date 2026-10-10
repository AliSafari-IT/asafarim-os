import { defineConfig, devices } from "@playwright/test";

/**
 * `pnpm screenshots` (repo root) starts the e2e environment (identity, the dev login stub, core-api, the
 * dev gateway, Notes and the Admin console) and then runs this config: e2e/screenshots.spec.ts drives
 * the real console and Notes and writes the PNGs the site uses to public/screenshots/.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "screenshots.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // One fixed size and scale: the PNGs stay comparable between runs and under the 300 KB budget.
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  },
});
