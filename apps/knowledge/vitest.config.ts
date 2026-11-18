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
  test: { include: ["test/**/*.test.ts"] },
});
