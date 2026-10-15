# docs.asafarim.site: the Docs app (apps/docs, #83). Build from the repository root:
#   docker build -f apps/docs/Dockerfile -t asafarim-os/docs .
# Stage 1 installs docs and its workspace packages, builds the packages, then the app as a Next.js
# standalone server, and fails if any fixture's text is in the build (documents are fetched at runtime,
# never baked in). Stage 2 runs that server as a non-root user on :3000; it works with a read-only root
# filesystem and tmpfs mounts on /tmp and .next/cache.

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile --filter @asafarim/docs... \
 && pnpm --filter "@asafarim/docs^..." run build \
 && BUILD_STANDALONE=true pnpm --filter @asafarim/docs run build \
 && node apps/docs/scripts/check-no-content.mjs --no-build

FROM node:24-alpine
# HOSTNAME: Next's standalone server binds to it, and Docker would otherwise set it to the container id.
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/docs/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/docs/.next/static ./apps/docs/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "apps/docs/server.js"]
