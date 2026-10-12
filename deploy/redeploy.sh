#!/usr/bin/env bash
#
# Redeploy the asafarim.site landing page with the NEWEST build (asafarim-os): one command, no shas to look up.
# Run by the OWNER on the VPS, from the repository folder (normally /var/repos/asafarim-os). Nothing else runs it.
#
#   pnpm redeploy                   (the same as deploy/redeploy.sh; pnpm is optional on the VPS)
#   deploy/redeploy.sh --dry-run    print what it would deploy, and change nothing
#
# What it does:
#   1. fetch origin/main; <commit> is its newest commit;
#   2. <site-image-commit> is the newest commit on origin/main that changed what the site image is built from
#      (the same paths as .github/workflows/site-image.yml: a test keeps the two lists equal). That is the commit the
#      "Site image" workflow tags the newest image with: the image is built only when those paths change;
#   3. check that image is published. If it is not (the workflow may still be building), it stops and says so: it
#      never quietly deploys an older image;
#   4. bring this checkout to <commit>, so the newest deploy/vps-deploy.sh runs (under the deploy lock), then hand over to
#      `deploy/vps-deploy.sh --site-only <commit> <site-image-commit>`, which does everything else and prints its own
#      steps (see deploy/README.md, "Landing page only").
#
# It is for the landing page only: while identity runs in this stack, vps-deploy.sh --site-only refuses, and the
# full deploy (with its identity image) is still `deploy/vps-deploy.sh <commit> [<image-commit>] [<site-image-commit>]`.
# It holds no secret and prints none. Rollback: deploy/README.md.
set -euo pipefail

# The inputs of the site image: the same list as `on.push.paths` in .github/workflows/site-image.yml.
SITE_IMAGE_PATHS=("core/site/**" "packages/app-manifest/schema/**" ".github/workflows/site-image.yml")
IMAGE_REPO="${REDEPLOY_IMAGE_REPO:-ghcr.io/alisafari-it/asafarim-os}"

# Everything lives in main(), called on ONE line at the very end: the reset in step 4 can replace this very file
# while bash is still reading it, and bash has parsed all of main() by then (as in vps-deploy.sh).
main() {
  local dry_run=false
  case "${1:-}" in
    "") ;;
    --dry-run) dry_run=true ;;
    *)
      echo "usage: deploy/redeploy.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
  [[ $# -le 1 ]] || { echo "usage: deploy/redeploy.sh [--dry-run]" >&2; exit 2; }

  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_dir"

  log() { echo "[redeploy $(date -Is)] $*"; }
  fatal() { echo "FATAL: $*" >&2; exit 1; }

  for tool in git docker flock; do
    command -v "$tool" >/dev/null 2>&1 || fatal "'${tool}' is not installed on this host."
  done

  # 1 and 2. What is newest.
  log "Fetching origin/main..."
  git fetch --prune origin main
  local commit site_commit
  commit="$(git rev-parse origin/main)"
  site_commit="$(git log -1 --format=%H origin/main -- "${SITE_IMAGE_PATHS[@]}")"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fatal "could not read origin/main."
  [[ "$site_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "no commit on origin/main changed the site image's inputs."
  log "Newest commit on main:  ${commit}"
  log "Newest site image from: ${site_commit}"

  # 3. Never deploy an older image than the newest one, quietly.
  local image="${IMAGE_REPO}:site-${site_commit}"
  if ! docker manifest inspect "$image" >/dev/null 2>&1; then
    fatal "${image} is not published (yet). The 'Site image' workflow may still be building it: check its run for ${site_commit:0:12} on GitHub, then run this again. If it failed there, fix that first. (If the build is done, the VPS may not be able to reach ghcr.io: run 'docker login ghcr.io' if the package is private.) Nothing changed."
  fi
  log "The image ${image##*/} exists."

  if [[ "$dry_run" == true ]]; then
    log "Dry run. It would run: deploy/vps-deploy.sh --site-only ${commit} ${site_commit}"
    exit 0
  fi

  # 4. Use the newest scripts. The reset takes the deploy lock, so it never lands in the middle of another deploy.
  if [[ "$(git rev-parse HEAD)" != "$commit" ]]; then
    log "Bringing this checkout to ${commit:0:12}..."
    flock -w 300 "${repo_dir}/.vps-deploy.lock" git reset --hard "$commit" ||
      fatal "could not update this checkout (another deploy holds ${repo_dir}/.vps-deploy.lock?). Nothing deployed."
  fi
  exec deploy/vps-deploy.sh --site-only "$commit" "$site_commit"
}

main "$@"; exit $?
