#!/usr/bin/env bash
#
# Deploy the ASafariM OS stack on the VPS: identity (id.asafarim.site, asafarim-os#45, part of #22), the
# asafarim.site landing page (os-site, #70), the Docs app (docs.asafarim.site, os-docs, #83) and the Breinhap landing
# page (breinhap.asafarim.site, breinhap-site; its image is pinned in deploy/compose.prod.yml, not passed here).
# Run by the OWNER, from the repository folder (normally /var/repos/asafarim-os). Nothing else runs it.
#
#   deploy/vps-deploy.sh <commit> [<image-commit>] [<site-image-commit>] [<docs-image-commit>] [<core-api-image-commit>] [<admin-image-commit>]
#   deploy/vps-deploy.sh --site-only <commit> [<site-image-commit>] [<docs-image-commit>]
#
#   <commit>        the repository state to deploy, as a full 40-character sha: this script, the
#                   compose file, the site file, the encrypted env. It must be on origin/main.
#   <image-commit>  the commit whose identity image to run (default: <commit>). The image workflow
#                   (#44) builds only when identity's inputs change, so the newest commit may have no
#                   image of its own: pass the sha shown by the latest "Identity image" run.
#   <site-image-commit>  the commit whose site image to run (default: <commit>). Same rule, with the
#                   "Site image" workflow (#70): pass the sha of its latest run.
#   <docs-image-commit>  the commit whose docs image to run (default: <commit>). Same rule, with the
#                   "Docs image" workflow (#83).
#   <core-api-image-commit>  the commit whose core-api image to run (default: <commit>), with the "Core API image"
#                   workflow. Used only when core-api is part of the deploy (below).
#   <admin-image-commit>  the commit whose Admin console image to run (default: <commit>), with the "Admin image"
#                   workflow (#175). Used only when the console is part of the deploy (below).
#   --site-only     the landing pages and docs, without identity (#97, #83): steps 1, 2 and 3 for the docs env
#                   only, 4 (edge_net and the edge script only), 5 and 6 for os-site, os-docs and breinhap-site only, then
#                   step 7 with sites/asafarim-os-site.caddy, and step 8: before the edge cutover, the same file
#                   for the Caddy that serves 443 today. It never decrypts identity's env, needs no identity_db
#                   and no clients.json, and never starts or touches identity or os-redis. It refuses to run
#                   while identity is running: the site-only file would take id.asafarim.site off the edge. A
#                   later full deploy replaces the site-only file.
#
# What it does, in this order (it stops at the first failure and says why):
#   1. fetch and `git reset --hard` to <commit>;
#   2. decrypt core/identity/.env.production.age into .env.identity and apps/docs/.env.production.age into
#      .env.docs, with plain `age` (mode 600);
#   3. check every variable listed in core/identity/.env.production.example and apps/docs/.env.production.example
#      is set: by NAME, never by value;
#   4. check the networks and the client config it needs exist;
#   5. `docker compose pull` (tried up to 3 times, 10s apart: DEPLOY_PULL_ATTEMPTS, DEPLOY_PULL_RETRY_DELAY), then
#      `up -d`;
#   6. wait for identity's /readyz, os-site's and breinhap-site's /healthz and os-docs's /api/health;
#   7. publish sites/asafarim-os.caddy on the shared edge (validate -> swap -> reload -> verify).
# Only step 7 makes id.asafarim.site, asafarim.site and docs.asafarim.site reachable, and only if every step before
# it passed.
#
# core-api (full mode only): when the commit has core/core-api/.env.production.age, steps 2 and 3 also decrypt it into
# .env.core-api and check core/core-api/.env.production.example's names; step 5 turns the compose profile "core" on,
# which starts os-postgres and os-core-api (never on edge_net; the admin API on 127.0.0.1:4020 only); step 6 also waits
# for os-core-api's /readyz. Without that file the deploy is exactly what it was before, and core-api is not started.
#
# The Admin console (admin.asafarim.site, os-admin, #175; full mode only): when core-api is part of the deploy and the
# commit has core/admin/.env.production.age, the same steps decrypt it into .env.admin, check
# core/admin/.env.production.example's names, start os-admin (profile "admin", on top of "core") and wait for its /api/health.
# asafarim.site cutover: remove the asafarim.site and www.asafarim.site blocks from asafarim-com.caddy first
# (deploy/README.md); until then step 7's validation refuses the duplicate host and keeps the old config.
#
# It holds no secret and prints none. Rollback: deploy/README.md.
set -euo pipefail

# Everything lives in main(), called on ONE line at the very end. Step 1 resets this checkout, which can
# replace this very file while bash is still reading it; bash has parsed all of main() by then.
main() {
  local usage="usage: deploy/vps-deploy.sh <commit> [<image-commit>] [<site-image-commit>] [<docs-image-commit>] [<core-api-image-commit>] [<admin-image-commit>] | --site-only <commit> [<site-image-commit>] [<docs-image-commit>]"
  local site_only=false with_core_api=false with_admin=false
  if [[ "${1:-}" == "--site-only" ]]; then
    site_only=true
    shift
    (($# <= 3)) || { echo "FATAL: ${usage}" >&2; exit 1; }
    # The same positions as a full deploy. There is no identity image here, so <image-commit> stays unset
    # (it defaults to <commit> and is never pulled).
    set -- "${1:-}" "" "${2:-}" "${3:-}"
  fi
  (($# <= 6)) || { echo "FATAL: ${usage}" >&2; exit 1; }
  local commit="${1:?$usage}"
  local image_commit="${2:-$commit}"
  local site_image_commit="${3:-$commit}"
  local docs_image_commit="${4:-$commit}"
  local core_api_image_commit="${5:-$commit}"
  local admin_image_commit="${6:-$commit}"

  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_dir"
  local edge_dir="${EDGE_DIR:-/var/repos/edge}"
  local compose=(docker compose -p asafarim-os -f deploy/compose.prod.yml)

  log() { echo "[deploy $(date -Is)] $*"; }
  fatal() { echo "FATAL: $*" >&2; exit 1; }

  # Step 5's pull, tried up to DEPLOY_PULL_ATTEMPTS times (default 3), DEPLOY_PULL_RETRY_DELAY seconds apart (default
  # 10). A pull can fail for a moment on the host (containerd's "failed commit on ref ... rename ... no such file", a
  # registry hiccup) while every image exists; one retry gets past it. Returns non-zero only when every attempt
  # failed, and the caller stops as before. Nothing is started until a pull succeeds.
  local pull_attempts="${DEPLOY_PULL_ATTEMPTS:-3}" pull_delay="${DEPLOY_PULL_RETRY_DELAY:-10}"
  [[ "$pull_attempts" =~ ^[1-9][0-9]*$ ]] || fatal "DEPLOY_PULL_ATTEMPTS must be a whole number of at least 1, got '${pull_attempts}'."
  [[ "$pull_delay" =~ ^[0-9]+$ ]] || fatal "DEPLOY_PULL_RETRY_DELAY must be a whole number of seconds, got '${pull_delay}'."
  pull_with_retry() {
    local attempt
    for ((attempt = 1; attempt <= pull_attempts; attempt++)); do
      "$@" && return 0
      if ((attempt < pull_attempts)); then
        log "The pull failed (attempt ${attempt} of ${pull_attempts}). Trying again in ${pull_delay}s..."
        sleep "$pull_delay"
      fi
    done
    log "The pull failed ${pull_attempts} time(s)."
    return 1
  }

  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<commit> must be a full 40-character sha, got '${commit}'."
  [[ "$image_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<image-commit> must be a full 40-character sha, got '${image_commit}'."
  [[ "$site_image_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<site-image-commit> must be a full 40-character sha, got '${site_image_commit}'."
  [[ "$docs_image_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<docs-image-commit> must be a full 40-character sha, got '${docs_image_commit}'."
  [[ "$core_api_image_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<core-api-image-commit> must be a full 40-character sha, got '${core_api_image_commit}'."
  [[ "$admin_image_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<admin-image-commit> must be a full 40-character sha, got '${admin_image_commit}'."
  # age in both modes: os-docs's env (AUTH_SECRET) is decrypted by a site-only deploy too.
  for tool in git age docker flock; do
    command -v "$tool" >/dev/null 2>&1 || fatal "'${tool}' is not installed on this host."
  done

  # One deploy at a time.
  exec 9>"${repo_dir}/.vps-deploy.lock"
  flock -w 300 9 || fatal "another deploy holds ${repo_dir}/.vps-deploy.lock (waited 300s). Nothing changed."

  # 1. The exact revision: compose file, site file and encrypted env can never come from different commits.
  log "Fetching origin/main..."
  git fetch --prune origin main
  git cat-file -e "${commit}^{commit}" 2>/dev/null || fatal "commit ${commit} is not in this repository."
  git merge-base --is-ancestor "$commit" origin/main || fatal "commit ${commit} is not on origin/main. Only main is deployed."
  git reset --hard "$commit"
  # The reset can bring a newer env checker than the one this run started with: load it now.
  # shellcheck source=deploy/lib/env-check.sh
  source "${repo_dir}/deploy/lib/env-check.sh"
  # shellcheck source=deploy/lib/live-caddy.sh
  source "${repo_dir}/deploy/lib/live-caddy.sh"

  # 2. Decrypt with plain age. The file is created private from the start, then moved into place.
  [[ -f .age/key.txt ]] || fatal ".age/key.txt is missing on this host. Provision it once (chmod 600)."
  # os-docs, in both modes. AUTH_SECRET only today; the app's later secrets join it (apps/docs/.env.production.example).
  log "Decrypting apps/docs/.env.production.age..."
  [[ -f apps/docs/.env.production.age ]] || fatal "apps/docs/.env.production.age is not in this commit."
  ( umask 077 && age -d -i .age/key.txt apps/docs/.env.production.age > .env.docs.tmp ) \
    || { rm -f .env.docs.tmp; fatal "age could not decrypt apps/docs/.env.production.age."; }
  mv -f .env.docs.tmp .env.docs
  chmod 600 .env.docs
  # 3. Every variable the example lists must be filled. The failure names it; it never shows a value.
  log "Checking the docs environment (names only)..."
  require_env_vars .env.docs apps/docs/.env.production.example \
    || fatal "fill the variables named above in apps/docs/.env.production, re-encrypt it, commit the .age file, and deploy that commit."

  if [[ "$site_only" != true ]]; then
    log "Decrypting core/identity/.env.production.age..."
    [[ -f core/identity/.env.production.age ]] || fatal "core/identity/.env.production.age is not in this commit."
    ( umask 077 && age -d -i .age/key.txt core/identity/.env.production.age > .env.identity.tmp ) \
      || { rm -f .env.identity.tmp; fatal "age could not decrypt core/identity/.env.production.age."; }
    mv -f .env.identity.tmp .env.identity
    chmod 600 .env.identity

    # 3. Every variable the example lists must be filled. The failure names it; it never shows a value.
    log "Checking the environment (names only)..."
    # Which names depends on IDENTITY_LOGIN_METHOD: hub needs the Hub hand-off, local its own database and SMTP.
    require_identity_env .env.identity core/identity/.env.production.example \
      || fatal "fill the variables named above in core/identity/.env.production, re-encrypt it, commit the .age file, and deploy that commit."

    # 4. What this stack cannot create for itself.
    docker network inspect identity_db >/dev/null 2>&1 \
      || fatal "the identity_db network does not exist. Deploy the asafarim-com change first (it creates the network and puts postgres on it)."
    [[ -f deploy/identity/clients.json && ! -L deploy/identity/clients.json ]] \
      || fatal "deploy/identity/clients.json is missing. Create it from core/identity/clients.example.json (see deploy/README.md); Docker would otherwise create a directory there."

    # core-api joins the deploy once its encrypted env is committed (core/core-api/.env.production.example says how).
    if [[ -f core/core-api/.env.production.age ]]; then
      with_core_api=true
      log "Decrypting core/core-api/.env.production.age..."
      ( umask 077 && age -d -i .age/key.txt core/core-api/.env.production.age > .env.core-api.tmp ) \
        || { rm -f .env.core-api.tmp; fatal "age could not decrypt core/core-api/.env.production.age."; }
      mv -f .env.core-api.tmp .env.core-api
      chmod 600 .env.core-api
      log "Checking the core-api environment (names only)..."
      require_env_vars .env.core-api core/core-api/.env.production.example \
        || fatal "fill the variables named above in core/core-api/.env.production (node deploy/core-api/new-env.mjs writes them all), re-encrypt it, commit the .age file, and deploy that commit."
    else
      log "No core/core-api/.env.production.age in this commit: core-api is not part of this deploy."
    fi

    # The Admin console joins once its encrypted env is committed, and only next to core-api (it is a client of it).
    if [[ -f core/admin/.env.production.age ]]; then
      [[ "$with_core_api" == true ]] \
        || fatal "core/admin/.env.production.age is in this commit but core/core-api/.env.production.age is not: the Admin console needs core-api."
      with_admin=true
      log "Decrypting core/admin/.env.production.age..."
      ( umask 077 && age -d -i .age/key.txt core/admin/.env.production.age > .env.admin.tmp ) \
        || { rm -f .env.admin.tmp; fatal "age could not decrypt core/admin/.env.production.age."; }
      mv -f .env.admin.tmp .env.admin
      chmod 600 .env.admin
      log "Checking the Admin console environment (names only)..."
      require_env_vars .env.admin core/admin/.env.production.example \
        || fatal "fill the variables named above in core/admin/.env.production, re-encrypt it, commit the .age file, and deploy that commit."
    else
      log "No core/admin/.env.production.age in this commit: the Admin console is not part of this deploy."
    fi
  fi
  docker network inspect edge_net >/dev/null 2>&1 \
    || fatal "the edge_net network does not exist. The shared edge is not installed on this host."
  [[ -f "${edge_dir}/scripts/edge-deploy-site.sh" ]] \
    || fatal "${edge_dir}/scripts/edge-deploy-site.sh is missing. The shared edge is not installed on this host."

  # 5. Pull and start.
  export IMAGE_TAG="$image_commit"
  export SITE_IMAGE_TAG="$site_image_commit"
  export DOCS_IMAGE_TAG="$docs_image_commit"
  # Always set, so the compose file renders; the image is only pulled when the "core" profile is on.
  export CORE_API_IMAGE_TAG="$core_api_image_commit"
  export ADMIN_IMAGE_TAG="$admin_image_commit"
  if [[ "$with_core_api" == true ]]; then
    export COMPOSE_PROFILES=core
    [[ "$with_admin" == true ]] && export COMPOSE_PROFILES=core,admin
  else
    unset COMPOSE_PROFILES
  fi
  if [[ "$site_only" == true ]]; then
    # The site-only file has no id.asafarim.site: publishing it while identity runs would take identity off the edge.
    local identity_running
    identity_running="$("${compose[@]}" ps -q identity)" || fatal "could not list this stack's containers. Nothing changed."
    [[ -z "$identity_running" ]] \
      || fatal "identity is running. A site-only deploy would take id.asafarim.site off the edge; run the full deploy instead. Nothing changed."
    # Only os-site, os-docs and breinhap-site, and without reading .env.identity (identity's env_file, which this mode
    # never creates).
    log "Checking the compose file (os-site, os-docs and breinhap-site only)..."
    "${compose[@]}" config -q --no-env-resolution os-site os-docs breinhap-site
    log "Pulling ghcr.io/alisafari-it/asafarim-os:site-${SITE_IMAGE_TAG}, :docs-${DOCS_IMAGE_TAG} and the pinned Breinhap site image..."
    pull_with_retry "${compose[@]}" pull os-site os-docs breinhap-site \
      || fatal "the pull failed. If the package is private, run 'docker login ghcr.io' on this host first; if an image does not exist, ${SITE_IMAGE_TAG} has no site image or ${DOCS_IMAGE_TAG} no docs image (see the 'Site image' and 'Docs image' workflow runs), or the Breinhap site image pinned in deploy/compose.prod.yml is not published (its 'Site image' run in AliSafari-IT/breinhap)."
    log "Starting os-site, os-docs and breinhap-site..."
    "${compose[@]}" up -d --no-deps os-site os-docs breinhap-site
  else
    log "Checking the compose file..."
    "${compose[@]}" config -q
    log "Pulling ghcr.io/alisafari-it/asafarim-os:identity-${IMAGE_TAG}, :site-${SITE_IMAGE_TAG} and :docs-${DOCS_IMAGE_TAG}$([[ "$with_core_api" == true ]] && echo ", :core-api-${CORE_API_IMAGE_TAG} and postgres:16-alpine")$([[ "$with_admin" == true ]] && echo ", :admin-${ADMIN_IMAGE_TAG}")..."
    if ! pull_with_retry "${compose[@]}" pull; then
      fatal "the pull failed. If the package is private, run 'docker login ghcr.io' on this host first; if an image does not exist, ${IMAGE_TAG} has no identity image, ${SITE_IMAGE_TAG} no site image, ${DOCS_IMAGE_TAG} no docs image or ${CORE_API_IMAGE_TAG} no core-api image or ${ADMIN_IMAGE_TAG} no admin image (see the 'Identity image', 'Site image', 'Docs image', 'Core API image' and 'Admin image' workflow runs), or the Breinhap site image pinned in deploy/compose.prod.yml is not published (its 'Site image' run in AliSafari-IT/breinhap)."
    fi
    log "Starting the stack..."
    "${compose[@]}" up -d --remove-orphans
  fi

  # 6. Ready means identity answers /readyz, which checks its Redis and the accounts database.
  if [[ "$site_only" != true ]]; then
    log "Waiting for identity's /readyz..."
    local ready=false
    for _ in $(seq 1 45); do
      if "${compose[@]}" exec -T identity wget -qO- http://127.0.0.1:3000/readyz >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 2
    done
    if [[ "$ready" != true ]]; then
      fatal "identity did not become ready within 90s. The site was NOT published. Look at: ${compose[*]} logs --tail 50 identity (logs hold names and codes, never secrets)."
    fi
    log "identity is ready."

    if [[ "$with_core_api" == true ]]; then
      # The first start initialises os-postgres (an empty volume) before core-api can migrate: allow two minutes.
      log "Waiting for os-core-api's /readyz..."
      local core_ready=false
      for _ in $(seq 1 60); do
        if "${compose[@]}" exec -T os-core-api wget -qO- http://127.0.0.1:4020/readyz >/dev/null 2>&1; then
          core_ready=true
          break
        fi
        sleep 2
      done
      if [[ "$core_ready" != true ]]; then
        fatal "os-core-api did not become ready within 120s. The site was NOT published. Look at: ${compose[*]} logs --tail 50 os-postgres os-core-api"
      fi
      log "os-core-api is ready."
    fi

    if [[ "$with_admin" == true ]]; then
      log "Waiting for os-admin's /api/health..."
      local admin_ready=false
      for _ in $(seq 1 30); do
        if "${compose[@]}" exec -T os-admin wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
          admin_ready=true
          break
        fi
        sleep 2
      done
      if [[ "$admin_ready" != true ]]; then
        fatal "os-admin did not become ready within 60s. The site was NOT published. Look at: ${compose[*]} logs --tail 50 os-admin"
      fi
      log "os-admin is ready."
    fi
  fi

  # os-site (asafarim.site) is static files: ready as soon as nginx answers /healthz.
  log "Waiting for os-site's /healthz..."
  local site_ready=false
  for _ in $(seq 1 15); do
    if "${compose[@]}" exec -T os-site wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
      site_ready=true
      break
    fi
    sleep 2
  done
  if [[ "$site_ready" != true ]]; then
    fatal "os-site did not become ready within 30s. The site was NOT published. Look at: ${compose[*]} logs --tail 50 os-site"
  fi
  log "os-site is ready."

  # breinhap-site (breinhap.asafarim.site) is static files too: ready as soon as nginx answers /healthz.
  log "Waiting for breinhap-site's /healthz..."
  local breinhap_ready=false
  for _ in $(seq 1 15); do
    if "${compose[@]}" exec -T breinhap-site wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
      breinhap_ready=true
      break
    fi
    sleep 2
  done
  if [[ "$breinhap_ready" != true ]]; then
    fatal "breinhap-site did not become ready within 30s. The site was NOT published. Look at: ${compose[*]} logs --tail 50 breinhap-site"
  fi
  log "breinhap-site is ready."

  # os-docs (docs.asafarim.site) is a Next.js server: ready when it answers /api/health, its manifest's health path.
  log "Waiting for os-docs's /api/health..."
  local docs_ready=false
  for _ in $(seq 1 30); do
    if "${compose[@]}" exec -T os-docs wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      docs_ready=true
      break
    fi
    sleep 2
  done
  if [[ "$docs_ready" != true ]]; then
    fatal "os-docs did not become ready within 60s. The site was NOT published. Look at: ${compose[*]} logs --tail 50 os-docs"
  fi
  log "os-docs is ready."

  # 7. Publish the site file. The edge validates the WHOLE config first and restores the old file on failure.
  # Both files are published under the same edge site name, so a full deploy replaces the site-only one.
  local site_file=sites/asafarim-os.caddy
  [[ "$site_only" == true ]] && site_file=sites/asafarim-os-site.caddy
  log "Publishing ${site_file} on the shared edge..."
  EDGE_DIR="$edge_dir" bash "${edge_dir}/scripts/edge-deploy-site.sh" asafarim-os "${repo_dir}/${site_file}"

  # 8. Before the edge cutover the edge only stores the file, so also install it for the Caddy that serves 443
  # today (deploy/lib/live-caddy.sh), in BOTH modes: the full file is what puts id.asafarim.site live there.
  # After the cutover this does nothing.
  log "Publishing ${site_file} on the live Caddy (before the edge cutover)..."
  publish_live_site "${repo_dir}/${site_file}" \
    || fatal "the live Caddy did not take ${site_file} (see above). The edge has it; the live Caddy is unchanged or restored."

  if [[ "$site_only" == true ]]; then
    log "Done. Check: curl -fsSI https://asafarim.site/ && curl -fsS https://docs.asafarim.site/api/health && curl -fsSI https://breinhap.asafarim.site/"
  else
    log "Done. Check: curl -fsS https://id.asafarim.site/.well-known/openid-configuration && curl -fsSI https://asafarim.site/ && curl -fsS https://docs.asafarim.site/api/health && curl -fsSI https://breinhap.asafarim.site/"
  fi
}

main "$@"; exit $?
