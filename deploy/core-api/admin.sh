#!/usr/bin/env bash
#
# The owner's admin commands for core-api in production, on the VPS. core-api's admin API listens on 127.0.0.1:4020
# only (deploy/compose.prod.yml); the bearer token is read from .env.core-api (decrypted by vps-deploy.sh) and never
# printed. Run from the repository folder (normally /var/repos/asafarim-os).
#
#   deploy/core-api/admin.sh install <app>       install apps/<app>/platform.app.json: writes the app's one-time
#                                                credential to .env.core-api-install-<app> (mode 600), never to the screen
#   deploy/core-api/admin.sh activate <app>      installed/inactive -> active
#   deploy/core-api/admin.sh grant <role> <subject>    e.g. grant docs.owner <your account id from id.asafarim.site/account>
#   deploy/core-api/admin.sh grants <subject>    the roles a subject holds
#   deploy/core-api/admin.sh apps                every app core-api knows, with its state
#
# Order for a new app (docs): install -> put the credential into the app's .env.production (re-encrypt, PR, deploy)
# -> activate -> the app registers on its next start, which creates its roles -> grant.
set -euo pipefail

main() {
  local usage="usage: deploy/core-api/admin.sh install <app> | activate <app> | grant <role> <subject> | grants <subject> | apps"
  local repo_dir
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  cd "$repo_dir"
  local api="${CORE_API_ADMIN_URL:-http://127.0.0.1:4020}"

  fatal() { echo "FATAL: $*" >&2; exit 1; }
  for tool in curl python3; do
    command -v "$tool" >/dev/null 2>&1 || fatal "'${tool}' is not installed on this host."
  done
  [[ -f .env.core-api ]] || fatal ".env.core-api is missing: deploy a commit with core/core-api/.env.production.age first."

  # The token, by name, from the dotenv file: the last assignment wins, quotes are stripped. Never echoed.
  local token
  token="$(python3 - .env.core-api <<'PY'
import sys
value = ""
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.rstrip("\r\n")
    if line.startswith("CORE_API_ADMIN_TOKEN="):
        value = line.split("=", 1)[1].strip().strip('"').strip("'")
print(value)
PY
)"
  [[ ${#token} -ge 32 ]] || fatal "CORE_API_ADMIN_TOKEN in .env.core-api is missing or shorter than 32 characters."

  # One request. The token goes in a header read from a private temp file, so it never shows in `ps`.
  call() {
    local method="$1" path="$2" body="${3:-}"
    local hdr
    hdr="$(mktemp)"
    chmod 600 "$hdr"
    printf 'Authorization: Bearer %s\n' "$token" > "$hdr"
    local -a args=(-sS -X "$method" -H "@${hdr}" -w '\n%{http_code}' "${api}${path}")
    [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" --data-binary "@${body}")
    local out
    out="$(curl "${args[@]}")" || { rm -f "$hdr"; fatal "core-api did not answer at ${api} (is os-core-api running? docker compose -p asafarim-os -f deploy/compose.prod.yml ps os-core-api)"; }
    rm -f "$hdr"
    RESPONSE_STATUS="${out##*$'\n'}"
    RESPONSE_BODY="${out%$'\n'*}"
  }
  ok() { [[ "$RESPONSE_STATUS" =~ ^2 ]] || fatal "core-api answered ${RESPONSE_STATUS}: ${RESPONSE_BODY}"; }
  app_id() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || fatal "'$1' is not an app id."; }
  subject_path() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

  case "${1:-}" in
    install)
      (($# == 2)) || fatal "$usage"
      app_id "$2"
      local manifest="apps/$2/platform.app.json" out=".env.core-api-install-$2"
      [[ -f "$manifest" ]] || fatal "${manifest} is not in this checkout."
      [[ ! -e "$out" ]] || fatal "${out} already exists: $2 was installed from here before. Use it, or remove it if it is stale."
      call POST "/admin/v1/apps/$2/install" "$manifest"
      ok
      # The credential and the database URL are shown once by core-api: keep them in a private file, not on screen.
      # noclobber: the redirect creates the file or fails if it exists (O_EXCL), in one step.
      ( set -o noclobber && umask 077 && python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
print("ASAFARIM_REGISTRY_CREDENTIAL=" + d["credential"])
if d.get("database") and d["database"].get("url"):
    print("DATABASE_URL=" + d["database"]["url"])
' <<<"$RESPONSE_BODY" > "$out" ) || fatal "could not write ${out}. core-api has installed $2: its credential was shown only once, so ask core-api to rotate it (remove and install again) if the file is lost."
      echo "Installed $2 (state: installed). Its one-time credential is in ${out} (mode 600)."
      echo "Next: copy those lines into apps/$2/.env.production (pnpm env:decrypt:production first), run"
      echo "pnpm env:encrypt:production, open a PR with apps/$2/.env.production.age, merge it, then:"
      echo "  deploy/core-api/admin.sh activate $2"
      echo "Delete ${out} once the PR is merged."
      ;;
    activate)
      (($# == 2)) || fatal "$usage"
      app_id "$2"
      call POST "/admin/v1/apps/$2/activate"
      ok
      echo "$RESPONSE_BODY"
      ;;
    grant)
      (($# == 3)) || fatal "$usage"
      [[ "$2" =~ ^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$ ]] || fatal "'$2' is not a role key (like docs.owner)."
      call PUT "/admin/v1/roles/$2/grants/$(subject_path "$3")"
      [[ "$RESPONSE_STATUS" != 404 ]] || fatal "core-api answered 404: ${RESPONSE_BODY}. A role exists once its app has registered: is the app active and restarted with its credential?"
      ok
      echo "$RESPONSE_BODY"
      ;;
    grants)
      (($# == 2)) || fatal "$usage"
      call GET "/admin/v1/subjects/$(subject_path "$2")/grants"
      ok
      echo "$RESPONSE_BODY"
      ;;
    apps)
      (($# == 1)) || fatal "$usage"
      call GET "/admin/v1/apps"
      ok
      python3 -c '
import json, sys
for a in json.loads(sys.stdin.read())["apps"]:
    print("%-16s %-10s v%s" % (a["id"], a["state"], a.get("version", "?")))
' <<<"$RESPONSE_BODY"
      ;;
    *)
      fatal "$usage"
      ;;
  esac
}

main "$@"; exit $?
