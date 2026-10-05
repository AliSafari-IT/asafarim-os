#!/usr/bin/env bash
# Test helper for deploy/vps-deploy.test.mjs: runs require_env_vars with the two files it is given.
# A static script (not a `bash -c` string) so no path is ever interpolated into shell code.
#   run-env-check.sh <env-file> <example-file>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/env-check.sh
source "$here/../lib/env-check.sh"
require_env_vars "$1" "$2"
