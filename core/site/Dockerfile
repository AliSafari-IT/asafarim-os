# asafarim.site, the OS's landing page (asafarim-os#70). Build from the repository root:
#   docker build -f core/site/Dockerfile -t asafarim-os/site .
# Stage 1 renders the static site with Node built-ins only (no install), plus the app manifest JSON Schema. Stage 2 serves it with
# unprivileged nginx on :8080; it works with a read-only root filesystem and a tmpfs /tmp.

FROM node:24-alpine AS build
# The repository's layout, so the build finds the manifest schema at ../../packages/app-manifest/schema (#87).
WORKDIR /repo/core/site
COPY core/site/src ./src
COPY core/site/public ./public
COPY packages/app-manifest/schema/app-manifest.schema.json /repo/packages/app-manifest/schema/
RUN node src/build.ts

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY core/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/core/site/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
