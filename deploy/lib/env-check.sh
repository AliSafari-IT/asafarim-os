#!/usr/bin/env bash
# Sourced by deploy/vps-deploy.sh; tested by deploy/vps-deploy.test.mjs.
#
#   require_env_vars <env-file> <example-file>
#
# Every variable the example file lists (an uncommented NAME= line) must be set, and not empty, in the
# env file. A failure names the variable(s) and NEVER prints a value: these files hold secrets.
require_env_vars() {
  local env_file="$1" example_file="$2" name line value
  local -a missing=()
  [[ -f "$env_file" ]] || { echo "env: ${env_file} does not exist" >&2; return 1; }
  [[ -f "$example_file" ]] || { echo "env: ${example_file} does not exist" >&2; return 1; }

  while IFS= read -r name; do
    # The last assignment wins, as when a dotenv file is read.
    line="$(grep -E "^${name}=" "$env_file" | tail -n 1 || true)"
    value="${line#*=}"
    value="${value%$'\r'}"
    # Trim whitespace, then treat a value that is only a pair of quotes as empty.
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == '""' || "$value" == "''" ]]; then value=""; fi
    if [[ -z "$line" || -z "$value" ]]; then missing+=("$name"); fi
  done < <(grep -oE '^[A-Z][A-Z0-9_]*=' "$example_file" | tr -d '=')

  if (( ${#missing[@]} > 0 )); then
    echo "env: missing or empty in ${env_file}: ${missing[*]}" >&2
    return 1
  fi
}
