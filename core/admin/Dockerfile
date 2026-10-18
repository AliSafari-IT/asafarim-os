# admin.asafarim.site: the Admin console (core/admin, asafarim-os#175). Build from the repository root:
#   docker build -f core/admin/Dockerfile -t asafarim-os/admin .
# Stage 1 installs the console and its workspace packages, builds the packages, then the app as a Next.js
# standalone server. Stage 2 runs that server as a non-root user on :3000; it works with a read-only root
# filesystem and tmpfs mounts on /tmp and .next/cache.

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile --filter @asafarim/admin... \
 && pnpm --filter "@asafarim/admin^..." run build \
 && BUILD_STANDALONE=true pnpm --filter @asafarim/admin run build

FROM node:24-alpine
# HOSTNAME: Next's standalone server binds to it, and Docker would otherwise set it to the container id.
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=root:root /repo/core/admin/.next/standalone ./
COPY --from=build --chown=root:root /repo/core/admin/.next/static ./core/admin/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "core/admin/server.js"]
