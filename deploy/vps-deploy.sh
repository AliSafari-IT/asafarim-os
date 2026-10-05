#!/usr/bin/env bash
#
# Deploy the ASafariM OS identity stack (id.asafarim.site) on the VPS: asafarim-os#45, part of #22.
# Run by the OWNER, from the repository folder (normally /var/repos/asafarim-os). Nothing else runs it.
#
#   deploy/vps-deploy.sh <commit> [<image-commit>]
#
#   <commit>        the repository state to deploy, as a full 40-character sha: this script, the
#                   compose file, the site file, the encrypted env. It must be on origin/main.
#   <image-commit>  the commit whose identity image to run (default: <commit>). The image workflow
#                   (#44) builds only when identity's inputs change, so the newest commit may have no
#                   image of its own: pass the sha shown by the latest "Identity image" run.
#
# What it does, in this order (it stops at the first failure and says why):
#   1. fetch and `git reset --hard` to <commit>;
#   2. decrypt core/identity/.env.production.age with plain `age` into .env.identity (mode 600);
#   3. check every variable listed in core/identity/.env.production.example is set: by NAME, never by value;
#   4. check the networks and the client config it needs exist;
#   5. `docker compose pull`, then `up -d`;
#   6. wait for identity's /readyz;
#   7. publish sites/asafarim-os.caddy on the shared edge (validate -> swap -> reload -> verify).
# Only step 7 makes id.asafarim.site reachable, and only if every step before it passed.
#
# It holds no secret and prints none. Rollback: deploy/README.md.
set -euo pipefail

# Everything lives in main(), called on ONE line at the very end. Step 1 resets this checkout, which can
# replace this very file while bash is still reading it; bash has parsed all of main() by then.
main() {
  local commit="${1:?usage: deploy/vps-deploy.sh <commit> [<image-commit>]}"
  local image_commit="${2:-$commit}"

  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_dir"
  local edge_dir="${EDGE_DIR:-/var/repos/edge}"
  local compose=(docker compose -p asafarim-os -f deploy/compose.prod.yml)

  log() { echo "[deploy $(date -Is)] $*"; }
  fatal() { echo "FATAL: $*" >&2; exit 1; }

  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<commit> must be a full 40-character sha, got '${commit}'."
  [[ "$image_commit" =~ ^[0-9a-f]{40}$ ]] || fatal "<image-commit> must be a full 40-character sha, got '${image_commit}'."
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

  # 2. Decrypt with plain age. The file is created private from the start, then moved into place.
  log "Decrypting core/identity/.env.production.age..."
  [[ -f .age/key.txt ]] || fatal ".age/key.txt is missing on this host. Provision it once (chmod 600)."
  [[ -f core/identity/.env.production.age ]] || fatal "core/identity/.env.production.age is not in this commit."
  ( umask 077 && age -d -i .age/key.txt core/identity/.env.production.age > .env.identity.tmp ) \
    || { rm -f .env.identity.tmp; fatal "age could not decrypt core/identity/.env.production.age."; }
  mv -f .env.identity.tmp .env.identity
  chmod 600 .env.identity

  # 3. Every variable the example lists must be filled. The failure names it; it never shows a value.
  log "Checking the environment (names only)..."
  require_env_vars .env.identity core/identity/.env.production.example \
    || fatal "fill the variables named above in core/identity/.env.production, re-encrypt it, commit the .age file, and deploy that commit."

  # 4. What this stack cannot create for itself.
  docker network inspect identity_db >/dev/null 2>&1 \
    || fatal "the identity_db network does not exist. Deploy the asafarim-com change first (it creates the network and puts postgres on it)."
  docker network inspect edge_net >/dev/null 2>&1 \
    || fatal "the edge_net network does not exist. The shared edge is not installed on this host."
  [[ -f deploy/identity/clients.json && ! -L deploy/identity/clients.json ]] \
    || fatal "deploy/identity/clients.json is missing. Create it from core/identity/clients.example.json (see deploy/README.md); Docker would otherwise create a directory there."
  [[ -f "${edge_dir}/scripts/edge-deploy-site.sh" ]] \
    || fatal "${edge_dir}/scripts/edge-deploy-site.sh is missing. The shared edge is not installed on this host."

  # 5. Pull and start.
  export IMAGE_TAG="$image_commit"
  log "Checking the compose file..."
  "${compose[@]}" config -q
  log "Pulling ghcr.io/alisafari-it/asafarim-os:identity-${IMAGE_TAG}..."
  if ! "${compose[@]}" pull; then
    fatal "the pull failed. If the package is private, run 'docker login ghcr.io' on this host first; if it does not exist, ${IMAGE_TAG} has no identity image (see the 'Identity image' workflow runs)."
  fi
  log "Starting the stack..."
  "${compose[@]}" up -d --remove-orphans

  # 6. Ready means identity answers /readyz, which checks its Redis and the accounts database.
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

  # 7. Publish the site file. The edge validates the WHOLE config first and restores the old file on failure.
  log "Publishing sites/asafarim-os.caddy on the shared edge..."
  EDGE_DIR="$edge_dir" bash "${edge_dir}/scripts/edge-deploy-site.sh" asafarim-os "${repo_dir}/sites/asafarim-os.caddy"

  log "Done. Check: curl -fsS https://id.asafarim.site/.well-known/openid-configuration"
}

main "$@"; exit $?
