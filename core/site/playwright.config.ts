import { defineConfig, devices } from "@playwright/test";

/**
 * The smoke test of the BUILT site (e2e/site.spec.ts). By default it serves dist/ with a tiny static
 * server (run `pnpm --filter @asafarim/site build` first); CI points SITE_URL at the os-site container
 * instead, with SITE_EXPECT_HEADERS=1 so the same test checks the container's security headers.
 */
const external = process.env.SITE_URL;
const PORT = 4190;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "site.spec.ts",
  retries: 0,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: external ?? `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: external
    ? undefined
    : { command: `node e2e/serve.ts ${PORT}`, url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: false },
});
