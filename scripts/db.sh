#!/usr/bin/env bash
# Local database bootstrap: start Postgres, wait until it accepts connections,
# then apply pending migrations (`--no-migrate` stops after readiness). Safe to
# run repeatedly.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_HOST="127.0.0.1"
DB_PORT="55432"
DB_USER="curved"
DB_NAME="curved"
READY_TIMEOUT_SECONDS=60

usage() {
  cat <<'EOF'
Usage: bash scripts/db.sh [--no-migrate]

Starts the Postgres container and waits until it accepts connections.

  --no-migrate  Stop once Postgres is ready; do not apply pending migrations
                to the local `curved` database.
  -h, --help    Show this message.
EOF
}

migrate=1
for arg in "$@"; do
  case "$arg" in
    --no-migrate)
      migrate=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'db: unknown argument %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

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

if [ "$migrate" -eq 1 ]; then
  node src/composition/migrate.ts
else
  printf 'db: skipping migrations (--no-migrate)\n'
fi
