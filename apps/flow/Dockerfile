# flow.asafarim.site: the Flow app (apps/flow). Build from the repository root:
#   docker build -f apps/flow/Dockerfile -t asafarim-os/flow .
# Stage 1 installs flow and its workspace packages, builds the packages, then the app as a Next.js standalone
# server. Stage 2 runs that server as a non-root user on :3000; it works with a read-only root filesystem and
# tmpfs mounts on /tmp and .next/cache. Without ASAFARIM_NATS_URL (production has no bus yet) it starts, serves its
# pages and answers /health/live; its subscribers and outbox relay stay off, each with one log line.

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile --filter @asafarim/flow... \
 && pnpm --filter "@asafarim/flow^..." run build \
 && BUILD_STANDALONE=true pnpm --filter @asafarim/flow run build

FROM node:24-alpine
# HOSTNAME: Next's standalone server binds to it, and Docker would otherwise set it to the container id.
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/flow/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/flow/.next/static ./apps/flow/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
CMD ["node", "apps/flow/server.js"]
