import { defineConfig, devices } from "@playwright/test";

/**
 * Knowledge's guest journeys in a real browser (#358), on their own: a throwaway PostgreSQL database seeded through
 * lib/ (e2e/seed.ts), and the production build served by `next start`. Guests only, so no identity stack is needed.
 *
 *   KNOWLEDGE_E2E_ADMIN_URL=postgres://postgres@localhost:5432/postgres pnpm --filter @asafarim/knowledge build
 *   KNOWLEDGE_E2E_ADMIN_URL=… pnpm --filter @asafarim/knowledge e2e
 */
const ADMIN_URL = process.env.KNOWLEDGE_E2E_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const url = new URL(ADMIN_URL);
url.pathname = "/knowledge_e2e";
export const E2E_DATABASE_URL = url.toString();
const PORT = Number(process.env.KNOWLEDGE_E2E_PORT ?? 4141);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/seed.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // A machine whose Chromium doesn't match this Playwright version can point at its own.
        launchOptions: process.env.KNOWLEDGE_E2E_CHROMIUM ? { executablePath: process.env.KNOWLEDGE_E2E_CHROMIUM } : {},
      },
    },
  ],
  webServer: {
    command: `next start --port ${PORT}`,
    url: `http://localhost:${PORT}/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      AUTH_SECRET: "knowledge-e2e-only-not-a-secret",
      AUTH_URL: `http://localhost:${PORT}`,
      // Likes and comments on lessons are on (lib/engagement.ts).
      ENGAGEMENT_SALT: "knowledge-e2e-only-engagement-salt",
    },
  },
});
