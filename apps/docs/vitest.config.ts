import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
      // `server-only` throws outside a React server bundle; in unit tests the code is plainly on the server.
      "server-only": path.resolve(import.meta.dirname, "test/server-only.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // test/routes.test.ts imports each page on first use; the first import transforms the app's whole module graph,
    // which under CI's parallel `pnpm test` can pass the 5 s default.
    testTimeout: 20_000,
  },
});
