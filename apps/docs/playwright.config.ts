import { defineConfig, devices } from "@playwright/test";

/**
 * The reader in a real browser (#80), against the real stack: `pnpm e2e` (repo root) builds Docs,
 * starts it on the made-up fixtures (DOCS_SOURCE_DIR) and runs this suite after notes and admin.
 * This config only drives the browser.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_DOCS_URL ?? "http://localhost:4110",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
