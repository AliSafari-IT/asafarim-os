import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Local development: `pnpm dev` writes the shared app env and this app's own credential into the
// git-ignored .dev/ folder. Values already in the environment win, so production env is untouched.
for (const file of ["app.env", "docs.env"]) {
  const p = path.join(process.cwd(), "../../.dev", file);
  if (existsSync(p)) process.loadEnvFile(p);
}

const nextConfig: NextConfig = {
  output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
  devIndicators: false,
  // The fixtures are read at runtime in development only. Their path is dynamic, so nothing traces them
  // today; this keeps it that way if that ever changes (scripts/check-no-content.mjs checks the build).
  outputFileTracingExcludes: { "*": ["./fixtures/**"] },
  transpilePackages: ["@asafarim/app-sdk"],
};

export default nextConfig;
