#!/usr/bin/env bash
#
# Redeploy the asafarim.site landing page and docs.asafarim.site with the NEWEST builds (asafarim-os): one command, no
# shas to look up.
# Run by the OWNER on the VPS, from the repository folder (normally /var/repos/asafarim-os). Nothing else runs it.
#
#   pnpm redeploy                   (the same as deploy/redeploy.sh; pnpm is optional on the VPS)
#   deploy/redeploy.sh --dry-run    print what it would deploy, and change nothing
#   deploy/redeploy.sh [--dry-run] <commit>
#                                   deploy that commit (a full sha on origin/main) instead of the newest one, with the
#                                   newest images as of that commit. The "Deploy" workflow uses this form, through
#                                   deploy/ci-deploy.sh, so it deploys exactly the commit CI passed on.
#
# What it does:
#   1. fetch origin/main; <commit> is its newest commit (or the one given, which must be on origin/main);
#   2. <site-image-commit> is the newest commit up to <commit> that changed what the site image is built from
#      (the same paths as .github/workflows/site-image.yml: a test keeps the two lists equal). That is the commit the
#      "Site image" workflow tags the newest image with: the image is built only when those paths change.
#      <docs-image-commit> is found the same way, with the paths of .github/workflows/docs-image.yml;
#   3. check both images are published. If one is not (its workflow may still be building), it stops and says so, with
#      exit code 3 (the workflow waits on that code): it never quietly deploys an older image;
#   4. bring this checkout to <commit>, so the newest deploy/vps-deploy.sh runs (under the deploy lock), then hand over to
#      `deploy/vps-deploy.sh --site-only <commit> <site-image-commit> <docs-image-commit>`, which does everything else
#      and prints its own steps (see deploy/README.md, "Landing page and docs").
#
# It is for the landing page and docs only: while identity runs in this stack, vps-deploy.sh --site-only refuses, and the
# full deploy (with its identity image) is still `deploy/vps-deploy.sh <commit> [<image-commit>] [<site-image-commit>]
# [<docs-image-commit>]`.
# It holds no secret and prints none. Rollback: deploy/README.md.
set -euo pipefail

# The inputs of the site image: the same list as `on.push.paths` in .github/workflows/site-image.yml.
SITE_IMAGE_PATHS=("core/site/**" "packages/app-manifest/schema/**" ".github/workflows/site-image.yml")
# The inputs of the docs image: the same list as `on.push.paths` in .github/workflows/docs-image.yml.
DOCS_IMAGE_PATHS=("apps/docs/**" "packages/**" "package.json" "pnpm-lock.yaml" "pnpm-workspace.yaml" ".github/workflows/docs-image.yml")
IMAGE_REPO="${REDEPLOY_IMAGE_REPO:-ghcr.io/alisafari-it/asafarim-os}"

# Everything lives in main(), called on ONE line at the very end: the reset in step 4 can replace this very file
# while bash is still reading it, and bash has parsed all of main() by then (as in vps-deploy.sh).
main() {
  local usage="usage: deploy/redeploy.sh [--dry-run] [<commit>]"
  local dry_run=false wanted=""
  if [[ "${1:-}" == "--dry-run" ]]; then
    dry_run=true
    shift
  fi
  if [[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]]; then
    wanted="$1"
  elif [[ $# -ne 0 ]]; then
    echo "$usage" >&2
    echo "<commit> is a full 40-character sha on origin/main." >&2
    exit 2
  fi

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
  local commit site_commit docs_commit
  if [[ -n "$wanted" ]]; then
    git cat-file -e "${wanted}^{commit}" 2>/dev/null || fatal "commit ${wanted} is not in this repository."
    git merge-base --is-ancestor "$wanted" origin/main || fatal "commit ${wanted} is not on origin/main. Only main is deployed."
    commit="$wanted"
  else
    commit="$(git rev-parse origin/main)"
  fi
  site_commit="$(git log -1 --format=%H "$commit" -- "${SITE_IMAGE_PATHS[@]}")"
  docs_commit="$(git log -1 --format=%H "$commit" -- "${DOCS_IMAGE_PATHS[@]}")"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fatal "could not read origin/main."
  [[ "$site_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "no commit on origin/main changed the site image's inputs."
  [[ "$docs_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "no commit on origin/main changed the docs image's inputs."
  if [[ -n "$wanted" ]]; then
    log "Commit to deploy:       ${commit}"
  else
    log "Newest commit on main:  ${commit}"
  fi
  log "Newest site image from: ${site_commit}"
  log "Newest docs image from: ${docs_commit}"

  # 3. Never deploy an older image than the newest one, quietly.
  local image workflow sha
  for image in "${IMAGE_REPO}:site-${site_commit}" "${IMAGE_REPO}:docs-${docs_commit}"; do
    sha="${image##*-}"
    workflow="Site image"
    [[ "${image##*:}" == docs-* ]] && workflow="Docs image"
    if ! docker manifest inspect "$image" >/dev/null 2>&1; then
      # Exit code 3, not 1: "not published (yet)" is the one failure the Deploy workflow waits out.
      echo "FATAL: ${image} is not published (yet). The '${workflow}' workflow may still be building it: check its run for ${sha:0:12} on GitHub, then run this again. If it failed there, fix that first. (If the build is done, the VPS may not be able to reach ghcr.io: run 'docker login ghcr.io' if the package is private.) Nothing changed." >&2
      exit 3
    fi
    log "The image ${image##*/} exists."
  done

  if [[ "$dry_run" == true ]]; then
    log "Dry run. It would run: deploy/vps-deploy.sh --site-only ${commit} ${site_commit} ${docs_commit}"
    exit 0
  fi

  # 4. Use the newest scripts. The reset takes the deploy lock, so it never lands in the middle of another deploy.
  if [[ "$(git rev-parse HEAD)" != "$commit" ]]; then
    log "Bringing this checkout to ${commit:0:12}..."
    flock -w 300 "${repo_dir}/.vps-deploy.lock" git reset --hard "$commit" ||
      fatal "could not update this checkout (another deploy holds ${repo_dir}/.vps-deploy.lock?). Nothing deployed."
  fi
  exec deploy/vps-deploy.sh --site-only "$commit" "$site_commit" "$docs_commit"
}

main "$@"; exit $?
