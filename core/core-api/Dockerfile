# ASafariM OS core-api (the control plane). Build from the repository root:
#   docker build -f core/core-api/Dockerfile -t asafarim-os/core-api .
# Runs as a non-root user and works with a read-only root filesystem. pg_dump (Postgres 16 client, the
# server's major version) is in the image: Remove backs an app's database up with it before deleting it.

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
# The workspace packages it imports (@asafarim/registry-protocol, app-manifest, events, telemetry) export dist/.
RUN pnpm install --frozen-lockfile --filter @asafarim/core-api... \
 && pnpm --filter "@asafarim/core-api^..." run build \
 && pnpm --filter @asafarim/core-api deploy --prod --legacy /out \
 && rm -rf /out/test

FROM node:24-alpine
RUN apk add --no-cache postgresql16-client \
 && mkdir -p /var/lib/core-api/backups \
 && chown node:node /var/lib/core-api/backups
ENV NODE_ENV=production PORT=4020 CORE_API_BACKUP_DIR=/var/lib/core-api/backups CORE_API_PG_DUMP=/usr/bin/pg_dump
WORKDIR /app
COPY --from=build --chown=root:root /out ./
USER node
EXPOSE 4020
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4020/healthz >/dev/null || exit 1
CMD ["node", "src/server.ts"]
