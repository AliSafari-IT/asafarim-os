# ASafariM OS identity service. Build from the repository root:
#   docker build -f core/identity/Dockerfile -t asafarim-os/identity .
# Runs as a non-root user and works with a read-only root filesystem.

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @asafarim/identity... \
 && pnpm --filter @asafarim/identity deploy --prod --legacy /out \
 && rm -rf /out/test /out/scripts

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=root:root /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "src/server.ts"]
