# asafarim.site, the OS's landing page (asafarim-os#70). Build from the repository root:
#   docker build -f core/site/Dockerfile -t asafarim-os/site .
# Stage 1 renders the static site with Node built-ins only (no install). Stage 2 serves it with
# unprivileged nginx on :8080; it works with a read-only root filesystem and a tmpfs /tmp.

FROM node:24-alpine AS build
WORKDIR /site
COPY core/site/src ./src
COPY core/site/public ./public
RUN node src/build.ts

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY core/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
