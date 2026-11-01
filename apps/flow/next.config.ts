import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Local development: `pnpm dev` writes the shared app env and this app's own credential into the
// git-ignored .dev/ folder. Values already in the environment win, so production env is untouched.
for (const file of ["app.env", "flow.env"]) {
  const p = path.join(process.cwd(), "../../.dev", file);
  if (existsSync(p)) process.loadEnvFile(p);
}
// Docs behind the dev gateway (the approval page links the draft's document there).
if (existsSync(path.join(process.cwd(), "../../.dev")))
  process.env.APP_CONFIG_DOCS_URL ??= "http://docs.localhost:8080";

const nextConfig: NextConfig = {
  output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
  devIndicators: false,
  // Inlined when the build runs, not read when the server does: only scripts/dev/e2e.mjs sets it, for
  // its own build, and it is what lets lib/egress/e2e.ts route calls to the local mocks. An image built
  // without it ignores FLOW_E2E_EGRESS whatever the server is given later.
  env: { FLOW_E2E_BUILD: process.env.FLOW_E2E_BUILD ?? "" },
  // pg and the OpenTelemetry SDK (@asafarim/telemetry) use Node APIs; keep them out of the bundler.
  serverExternalPackages: ["pg", "@asafarim/telemetry"],
  transpilePackages: ["@asafarim/app-sdk", "@asafarim/theme"],
  // unauthorized() and forbidden() answer 401 and 403 with app/unauthorized.tsx and app/forbidden.tsx.
  experimental: { authInterrupts: true },
};

export default nextConfig;
