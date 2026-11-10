#!/usr/bin/env bash
# Local database bootstrap: start Postgres, wait until it accepts connections,
# then apply pending migrations. Safe to run repeatedly.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_HOST="127.0.0.1"
DB_PORT="55432"
DB_USER="curved"
DB_NAME="curved"
READY_TIMEOUT_SECONDS=60

docker compose up -d --wait db

ready=0
for _ in $(seq 1 "$READY_TIMEOUT_SECONDS"); do
  if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  printf 'db: Postgres did not become ready at %s:%s within %ss.\n' \
    "$DB_HOST" "$DB_PORT" "$READY_TIMEOUT_SECONDS" >&2
  printf 'db: inspect the container with: docker compose logs db\n' >&2
  exit 1
fi

node src/migrate.ts
