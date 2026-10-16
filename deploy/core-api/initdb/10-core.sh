#!/bin/sh
# Runs once, on os-postgres's first start (an empty data volume): core-api's own login role and the core database
# it owns. The password comes from CORE_API_DB_PASSWORD (deploy/compose.prod.yml's env_file); it is passed as a
# psql variable, never echoed. core-api runs its migrations itself at every start.
set -eu
: "${CORE_API_DB_PASSWORD:?CORE_API_DB_PASSWORD is not set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v pw="$CORE_API_DB_PASSWORD" <<'SQL'
CREATE ROLE core_api LOGIN PASSWORD :'pw';
CREATE DATABASE core OWNER core_api;
REVOKE CONNECT ON DATABASE core FROM PUBLIC;
SQL
