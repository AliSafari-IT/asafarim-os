import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Local development: `pnpm dev` writes the shared app env and this app's own credential into the
// git-ignored .dev/ folder. Values already in the environment win, so production env is untouched.
for (const file of ["app.env", "docs.env"]) {
  const p = path.join(process.cwd(), "../../.dev", file);
  if (existsSync(p)) process.loadEnvFile(p);
}

/** Every response of this app, pages, API answers, images and error pages alike: never indexed (#79). */
export const ROBOTS_HEADER = { key: "X-Robots-Tag", value: "noindex, nofollow" };

const nextConfig: NextConfig = {
  output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
  devIndicators: false,
  // The fixtures are read at runtime in development only. Their path is dynamic, so nothing traces them
  // today; this keeps it that way if that ever changes (scripts/check-no-content.mjs checks the build).
  outputFileTracingExcludes: { "*": ["./fixtures/**"] },
  transpilePackages: ["@asafarim/app-sdk"],
  // pg uses Node APIs; keep it out of the bundler (study notes, #81).
  serverExternalPackages: ["pg"],
  // unauthorized() and forbidden() answer 401 and 403 with app/unauthorized.tsx and app/forbidden.tsx (#79).
  experimental: { authInterrupts: true },
  async headers() {
    return [{ source: "/:path*", headers: [ROBOTS_HEADER] }];
  },
};

export default nextConfig;
