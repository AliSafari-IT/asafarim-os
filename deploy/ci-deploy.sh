#!/usr/bin/env bash
#
# The VPS end of the "Deploy" workflow (.github/workflows/deploy.yml): the ONE command its SSH key may run.
#
# The key is installed in the deploy user's ~/.ssh/authorized_keys as a forced command (deploy/README.md, "Automatic
# deploy"), so whatever the workflow asks for arrives here in SSH_ORIGINAL_COMMAND and nothing else runs:
#
#   restrict,command="/var/repos/asafarim-os/deploy/ci-deploy.sh" ssh-ed25519 AAAA... asafarim-os-deploy
#
# The only request it accepts is exactly `deploy <sha>`, a full 40-character sha on origin/main. Then it:
#   1. fetches origin/main and refuses a sha that is not on it;
#   2. brings this checkout to <sha> under the deploy lock, so the scripts of that commit run;
#   3. hands over to `deploy/redeploy.sh <sha>`: the landing page and docs, with the newest images as of <sha> (it stops,
#      changing nothing, if one isn't published), via `vps-deploy.sh --site-only` (or the full deploy once identity runs).
# Run by hand (no SSH_ORIGINAL_COMMAND), it takes the same words as arguments: deploy/ci-deploy.sh deploy <sha>.
#
# It never starts identity: once identity runs, redeploy.sh does the full deploy so it stays live; the first identity
# deploy is the owner's (`deploy/redeploy.sh --with-identity`, deploy/README.md). It holds no secret and prints none.
set -euo pipefail

# Everything lives in main(), called on ONE line at the very end: step 2 can replace this very file while bash is still
# reading it (as in vps-deploy.sh).
main() {
  local request="${SSH_ORIGINAL_COMMAND-$*}"
  log() { echo "[ci-deploy $(date -Is)] $*"; }
  fatal() { echo "FATAL: $*" >&2; exit 1; }

  # Nothing from the request reaches a shell: it is matched whole, and only the sha is taken from it.
  local sha_re='^deploy ([0-9a-f]{40})$'
  [[ "$request" =~ $sha_re ]] || {
    echo "usage: deploy <full 40-character sha on origin/main>" >&2
    exit 2
  }
  local sha="${BASH_REMATCH[1]}"

  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_dir"
  for tool in git flock; do
    command -v "$tool" >/dev/null 2>&1 || fatal "'${tool}' is not installed on this host."
  done

  # 1. Only main is deployed.
  log "Fetching origin/main..."
  git fetch --prune origin main
  git cat-file -e "${sha}^{commit}" 2>/dev/null || fatal "commit ${sha} is not in this repository."
  git merge-base --is-ancestor "$sha" origin/main || fatal "commit ${sha} is not on origin/main. Only main is deployed."

  # 2. The scripts of that commit. The reset takes the deploy lock, so it never lands in the middle of another deploy.
  if [[ "$(git rev-parse HEAD)" != "$sha" ]]; then
    log "Bringing this checkout to ${sha:0:12}..."
    flock -w 300 "${repo_dir}/.vps-deploy.lock" git reset --hard "$sha" ||
      fatal "could not update this checkout (another deploy holds ${repo_dir}/.vps-deploy.lock?). Nothing deployed."
  fi

  # 3.
  exec deploy/redeploy.sh "$sha"
}

main "$@"; exit $?
