# learn.asafarim.site: ASafariM Knowledge (apps/knowledge). Build from the repository root:
#   docker build -f apps/knowledge/Dockerfile -t asafarim-os/knowledge .
# Stage 1 installs knowledge and its workspace packages, builds the packages, then the app as a Next.js standalone
# server. Stage 2 runs that server as a non-root user on :3000; it works with a read-only root filesystem and
# tmpfs mounts on /tmp and .next/cache. It migrates its own database on first use (apps/knowledge/lib/migrations.ts).

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile --filter @asafarim/knowledge... \
 && pnpm --filter "@asafarim/knowledge^..." run build \
 && BUILD_STANDALONE=true pnpm --filter @asafarim/knowledge run build

FROM node:24-alpine
# HOSTNAME: Next's standalone server binds to it, and Docker would otherwise set it to the container id.
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/knowledge/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/knowledge/.next/static ./apps/knowledge/.next/static
# The standalone server serves public/ (the web app manifest's icons) but doesn't include it in its output.
COPY --from=build --chown=root:root /repo/apps/knowledge/public ./apps/knowledge/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
CMD ["node", "apps/knowledge/server.js"]
