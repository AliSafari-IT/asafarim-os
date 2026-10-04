import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Local development: `pnpm dev` writes the shared app env and this app's own
// credential into the git-ignored .dev/ folder. Next.js only reads .env files
// from the app directory, so load them here. Values already in the environment
// win (process.loadEnvFile never overrides), so production env is untouched.
for (const file of ["app.env", "notes.env"]) {
  const p = path.join(process.cwd(), "../../.dev", file);
  if (existsSync(p)) process.loadEnvFile(p);
}

const nextConfig: NextConfig = {
  output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
  // Hide the floating Next.js dev-tools indicator.
  devIndicators: false,
  // pg and the SDK use Node APIs; keep them out of the bundler.
  serverExternalPackages: ["pg"],
  transpilePackages: ["@asafarim/app-sdk"],
};

export default nextConfig;
