#!/usr/bin/env bash
# Sourced by deploy/vps-deploy.sh; tested by deploy/vps-deploy.test.mjs.
#
#   require_env_vars <env-file> <example-file>
#       Every variable the example file lists (an uncommented NAME= line) must be set, and not empty, in the env file.
#   require_env_names <env-file> <NAME>...
#       The same check, for the names given.
#   require_identity_env <env-file> <example-file>
#       Identity's check: the names its login method needs (identity_required_vars).
#
# A failure names the variable(s) and NEVER prints a value: these files hold secrets.

# The value of NAME in a dotenv file, trimmed, with a quotes-only value read as empty. The last assignment wins.
# Internal: callers compare it, they never print it.
env_value() {
  local env_file="$1" name="$2" line value
  line="$(grep -E "^${name}=" "$env_file" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == '""' || "$value" == "''" ]]; then value=""; fi
  printf '%s' "$value"
}

require_env_names() {
  local env_file="$1" name
  shift
  local -a missing=()
  [[ -f "$env_file" ]] || { echo "env: ${env_file} does not exist" >&2; return 1; }
  for name in "$@"; do
    [[ -n "$name" ]] || continue
    [[ -n "$(env_value "$env_file" "$name")" ]] || missing+=("$name")
  done
  if (( ${#missing[@]} > 0 )); then
    echo "env: missing or empty in ${env_file}: ${missing[*]}" >&2
    return 1
  fi
}

require_env_vars() {
  local env_file="$1" example_file="$2"
  [[ -f "$example_file" ]] || { echo "env: ${example_file} does not exist" >&2; return 1; }
  local -a names=()
  mapfile -t names < <(grep -oE '^[A-Z][A-Z0-9_]*=' "$example_file" | tr -d '=')
  require_env_names "$env_file" "${names[@]}"
}

# The names identity needs, one per line, for the login method its env file sets (core/identity/src/config.ts):
#   hub (the default): every uncommented variable in the example (the Hub hand-off and the platform accounts DB);
#   local or sms: signing keys, cookie keys, its own database and the code secret, plus what each sign-in method
#   needs (email: an SMTP host and sender; sms with Twilio: the account, token and sender). The Hub variables and
#   IDENTITY_ACCOUNTS_DATABASE_URL are not needed then.
identity_required_vars() {
  local env_file="$1" example_file="$2" method methods provider
  [[ -f "$env_file" ]] || { echo "env: ${env_file} does not exist" >&2; return 1; }
  [[ -f "$example_file" ]] || { echo "env: ${example_file} does not exist" >&2; return 1; }
  method="$(env_value "$env_file" IDENTITY_LOGIN_METHOD)"
  case "${method:-hub}" in
    hub)
      grep -oE '^[A-Z][A-Z0-9_]*=' "$example_file" | tr -d '='
      ;;
    local | sms)
      printf '%s\n' IDENTITY_OIDC_JWKS IDENTITY_COOKIE_KEYS IDENTITY_DATABASE_URL IDENTITY_OTP_SECRET
      methods="$(env_value "$env_file" IDENTITY_SIGN_IN_METHODS)"
      if [[ -z "$methods" ]]; then
        if [[ "$method" == sms ]]; then methods=sms; else methods=email,passkey; fi
      fi
      if [[ ",${methods// /}," == *,email,* ]] && [[ "$(env_value "$env_file" IDENTITY_EMAIL_PROVIDER)" != dev-log ]]; then
        printf '%s\n' IDENTITY_SMTP_HOST IDENTITY_SMTP_FROM
      fi
      if [[ ",${methods// /}," == *,sms,* ]]; then
        provider="$(env_value "$env_file" IDENTITY_SMS_PROVIDER)"
        if [[ "${provider:-twilio}" == twilio ]]; then
          printf '%s\n' IDENTITY_TWILIO_ACCOUNT_SID IDENTITY_TWILIO_AUTH_TOKEN IDENTITY_TWILIO_FROM
        fi
      fi
      ;;
    *)
      echo "env: IDENTITY_LOGIN_METHOD in ${env_file} must be hub, local or sms" >&2
      return 1
      ;;
  esac
}

require_identity_env() {
  local env_file="$1" example_file="$2" list
  list="$(identity_required_vars "$env_file" "$example_file")" || return 1
  local -a names=()
  mapfile -t names <<<"$list"
  require_env_names "$env_file" "${names[@]}"
}
