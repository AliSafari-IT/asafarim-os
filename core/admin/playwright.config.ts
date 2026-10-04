import { defineConfig, devices } from "@playwright/test";

/**
 * The Admin console acceptance flow (P3.3b) against the real stack: identity, the dev
 * login stub, core-api and Postgres. `pnpm e2e` (repo root) starts all of it;
 * this config only drives the browser.
 */
export default defineConfig({
  testDir: "./e2e",
  // One flow, in order: each step builds on the previous one's grants.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_ADMIN_URL ?? "http://core.localhost:8080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
