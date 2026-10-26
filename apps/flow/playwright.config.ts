import { defineConfig, devices } from "@playwright/test";

/**
 * Flow in a real browser, against the real stack and bus: `pnpm e2e` (repo root) builds Flow, starts
 * it next to Docs and runs this suite last. This config only drives the browser.
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
    baseURL: process.env.E2E_FLOW_URL ?? "http://localhost:4120",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
