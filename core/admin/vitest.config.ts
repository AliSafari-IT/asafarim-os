import { defineConfig } from "vitest/config";

// Unit tests only: e2e/ belongs to Playwright (`pnpm e2e`).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
});
