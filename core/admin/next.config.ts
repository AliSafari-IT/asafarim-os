import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Local development: `pnpm dev` writes the shared app env (.dev/app.env: OIDC issuer, AUTH_SECRET,
// CORE_API_URL) and the console's own (.dev/admin.env) into the git-ignored .dev/ folder. Next.js
// only reads .env files from the app directory, so load them here. Values already in the
// environment win (process.loadEnvFile never overrides), so production env is untouched.
for (const file of ["app.env", "admin.env"]) {
  const p = path.join(process.cwd(), "../../.dev", file);
  if (existsSync(p)) process.loadEnvFile(p);
}

const nextConfig: NextConfig = {
  output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
  devIndicators: false,
  transpilePackages: ["@asafarim/app-sdk"],
  // forbidden() answers a real 403 for a signed-in person who isn't an administrator.
  experimental: { authInterrupts: true },
};

export default nextConfig;
