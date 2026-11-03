#!/usr/bin/env bash
# Seeds the mock products catalog into $POSTGRES_DB.
#
# The postgres image runs this automatically the first time the container
# starts with an empty data volume (db-scripts is mounted at
# /docker-entrypoint-initdb.d). The SQL lives in sql/ because the entrypoint
# would otherwise run a top-level .sql file a second time on its own.
#
# The SQL drops and recreates its own objects, so it is safe to rerun:
#   docker compose exec postgres bash /docker-entrypoint-initdb.d/01-seed-catalog.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

psql -v ON_ERROR_STOP=1 \
    --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DB}" \
    -f "${SCRIPT_DIR}/sql/catalog.sql"
