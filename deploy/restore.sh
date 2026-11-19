#!/usr/bin/env bash
# Restore the production Curved stack from a published backup set.
#
# A restore is destructive: the Postgres dump is replayed with --clean, and a
# Caddy restore overwrites the archived volumes. Nothing runs until --yes is
# given and every artifact passes the set's SHA256SUMS.
#
# Postgres restores into POSTGRES_DB stop the app first and leave it stopped,
# so the restored data is verified before anything serves from it. Passing
# --database NAME restores into a separate database as a drill; the app keeps
# running and the target database is created when absent.
#
# Usage:
#   deploy/restore.sh postgres <backup-set-dir> [--database NAME] [--yes]
#                     [--env-file PATH] [--compose-file PATH]
#                     [--project NAME]
#   deploy/restore.sh caddy <backup-set-dir> [--yes]
#                     [--env-file PATH] [--compose-file PATH]
#                     [--project NAME]
#
# <backup-set-dir> is a directory from deploy/backup.sh, including its
# `latest` symlink. It must hold manifest.txt, SHA256SUMS, and postgres.dump.
#
# Exit codes: 2 for usage refusals, 1 for any restore failure, 0 on success.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(dirname -- "$SCRIPT_DIR")

PROJECT_NAME="curved-prod"
MODE=""
BACKUP_SET=""
DATABASE=""
YES=0
ENV_FILE="deploy/.env"
COMPOSE_FILE="deploy/docker-compose.yml"

usage() {
  cat <<'EOF'
Usage: deploy/restore.sh postgres <backup-set-dir> [options]
       deploy/restore.sh caddy <backup-set-dir> [options]

Restore the production Compose stack from a backup set written by
deploy/backup.sh.

<backup-set-dir> must contain manifest.txt, SHA256SUMS, and postgres.dump. It
is resolved with realpath, so a `latest` symlink works. Every artifact is
checked against SHA256SUMS before any destructive step.

Both modes refuse to run without --yes and exit 2 instead.

Postgres:
  The dump is replayed into POSTGRES_DB with pg_restore --clean --if-exists,
  which replaces the current schema and data. The app is stopped first and is
  never started again by this script. Restore service yourself with
  ./deploy/release.sh rollback <tag> (or bring the app up with the image that
  matches this backup) once the data is verified.

  --database NAME restores into a separate database instead. The app is left
  running and NAME is created when it does not exist. Use this to drill a
  restore and drop the database afterwards.

Caddy:
  Restores the archived /data and /config volumes, replacing whatever the
  caddy container currently holds. The container is stopped, the archives are
  extracted, and caddy is started again. The set must record caddy=archived.

Options:
  --database NAME      Postgres target database (default $POSTGRES_DB). Must
                       match ^[A-Za-z_][A-Za-z0-9_]{0,62}$. Postgres only.
  --yes                Required. Confirms this destructive restore.
  --env-file PATH      Compose environment file (default deploy/.env).
  --compose-file PATH  Compose file (default deploy/docker-compose.yml).
  --project NAME       Compose project name (default curved-prod).
  -h, --help           Show this message and exit.

Requires docker compose v2, realpath, sha256sum, and tar. Run it from anywhere
inside the checkout.
EOF
}

argument_error() {
  printf 'restore: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

if [ -t 2 ]; then
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  RED=""
  RESET=""
fi

fail() {
  printf '%srestore: error: %s%s\n' "$RED" "${1:-failed}" "$RESET" >&2
  exit 1
}

info() {
  printf 'restore: %s\n' "$1"
}

# The first two positionals are the mode and the backup set. Every option may
# appear before or after them.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes)
      YES=1
      shift
      ;;
    --database)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a database name"
      fi
      DATABASE=$2
      shift 2
      ;;
    --env-file)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      ENV_FILE=$2
      shift 2
      ;;
    --compose-file)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      COMPOSE_FILE=$2
      shift 2
      ;;
    --project)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a project name"
      fi
      PROJECT_NAME=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      argument_error "unknown argument $1"
      ;;
    *)
      if [ -z "$MODE" ]; then
        MODE=$1
      elif [ -z "$BACKUP_SET" ]; then
        BACKUP_SET=$1
      else
        argument_error "unexpected argument $1"
      fi
      shift
      ;;
  esac
done

case "$MODE" in
  postgres | caddy) ;;
  '')
    argument_error "a restore mode is required (postgres or caddy)"
    ;;
  *)
    argument_error "unknown restore mode '$MODE'; expected postgres or caddy"
    ;;
esac

if [ -z "$BACKUP_SET" ]; then
  argument_error "a backup set directory is required"
fi

if [ "$MODE" != "postgres" ] && [ -n "$DATABASE" ]; then
  argument_error "--database is only valid for the postgres restore"
fi

if [ -n "$DATABASE" ]; then
  if ! [[ "$DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
    argument_error "--database '$DATABASE' is not a valid database name; it must match ^[A-Za-z_][A-Za-z0-9_]{0,62}$"
  fi
fi

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v realpath >/dev/null 2>&1 || fail "realpath is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

if [ "$YES" -ne 1 ]; then
  printf 'restore: refusing to restore without --yes\n' >&2
  exit 2
fi

# The backup set is a caller-supplied path, so resolve it against the invoking
# directory before moving to the repo root. The env and compose defaults are
# repo-relative.
BACKUP_SET=$(realpath -e -- "$BACKUP_SET" 2>/dev/null) || true
if [ -z "$BACKUP_SET" ] || [ ! -d "$BACKUP_SET" ]; then
  fail "backup set directory does not exist"
fi

for required in manifest.txt SHA256SUMS postgres.dump; do
  if [ ! -f "$BACKUP_SET/$required" ]; then
    fail "backup set $BACKUP_SET is missing $required"
  fi
done

cd "$REPO_ROOT"

ENV_FILE=$(realpath -m -- "$ENV_FILE")
COMPOSE_FILE=$(realpath -m -- "$COMPOSE_FILE")

[ -r "$ENV_FILE" ] || fail "environment file $ENV_FILE is missing or unreadable"
[ -f "$COMPOSE_FILE" ] || fail "compose file $COMPOSE_FILE is missing"

# Load the environment file exactly as Compose does, so POSTGRES_USER,
# POSTGRES_DB, and the interpolation in the compose file all agree. Values
# become part of this environment only; secrets are never printed.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ -n "${POSTGRES_USER:-}" ] || fail "POSTGRES_USER is not set in $ENV_FILE"
[ -n "${POSTGRES_DB:-}" ] || fail "POSTGRES_DB is not set in $ENV_FILE"

COMPOSE=(docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# --yes is checked and every artifact is hashed before the first stop, create,
# or overwrite, so an interrupted or mismatched set never touches the stack.
info "verifying $BACKUP_SET/SHA256SUMS"
if ! (cd -- "$BACKUP_SET" && sha256sum -c --status SHA256SUMS); then
  fail "checksum verification failed for $BACKUP_SET; nothing was restored"
fi
info "checksums ok"

restore_postgres() {
  local target=$DATABASE
  local start elapsed exists tag

  if [ -z "$target" ]; then
    target=$POSTGRES_DB
  fi

  if [ "$target" = "$POSTGRES_DB" ]; then
    info "stopping the app; this restore targets the production database"
    "${COMPOSE[@]}" stop app || fail "could not stop the app container"
    info "the app is stopped and will stay stopped"
  else
    info "restoring into the separate database $target; the app keeps running"
  fi

  exists=$("${COMPOSE[@]}" exec -T db psql -U "$POSTGRES_USER" -d postgres \
    -tAc "SELECT 1 FROM pg_database WHERE datname='$target'") \
    || fail "could not query the database server for $target"
  exists=$(printf '%s' "$exists" | tr -d '[:space:]')
  if [ "$exists" != "1" ]; then
    info "creating database $target"
    "${COMPOSE[@]}" exec -T db psql -U "$POSTGRES_USER" -d postgres \
      -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$target\"" \
      || fail "could not create database $target"
  fi

  info "restoring $BACKUP_SET/postgres.dump into $target"
  start=$SECONDS
  "${COMPOSE[@]}" exec -T db pg_restore -U "$POSTGRES_USER" -d "$target" \
    --clean --if-exists --no-owner --no-privileges \
    < "$BACKUP_SET/postgres.dump" \
    || fail "pg_restore failed for database $target"
  elapsed=$((SECONDS - start))

  if [ "$target" = "$POSTGRES_DB" ]; then
    tag=$(grep -m 1 '^tag=' "$BACKUP_SET/manifest.txt" 2>/dev/null | cut -d= -f2- || true)
    [ -n "$tag" ] || tag="<tag>"
    info "the app stayed stopped; bring it back with ./deploy/release.sh rollback $tag (or up) using the image that matches this backup"
  else
    info "this was a drill; drop the restored database with: ${COMPOSE[*]} exec -T db dropdb -U '$POSTGRES_USER' '$target'"
  fi

  printf 'restore: ok postgres %s in %ss\n' "$target" "$elapsed"
}

restore_caddy() {
  if ! grep -qx 'caddy=archived' "$BACKUP_SET/manifest.txt"; then
    fail "backup set $BACKUP_SET does not record caddy=archived; there is no Caddy volume to restore"
  fi

  if [ ! -f "$BACKUP_SET/caddy-data.tar.gz" ]; then
    fail "backup set $BACKUP_SET is missing caddy-data.tar.gz"
  fi
  if [ ! -f "$BACKUP_SET/caddy-config.tar.gz" ]; then
    fail "backup set $BACKUP_SET is missing caddy-config.tar.gz"
  fi

  tar -tzf "$BACKUP_SET/caddy-data.tar.gz" >/dev/null \
    || fail "caddy-data.tar.gz is not a readable tar archive"
  tar -tzf "$BACKUP_SET/caddy-config.tar.gz" >/dev/null \
    || fail "caddy-config.tar.gz is not a readable tar archive"

  info "stopping caddy"
  "${COMPOSE[@]}" stop caddy || fail "could not stop the caddy container"

  info "restoring /data"
  "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh caddy \
    -c 'tar -C /data -xzf -' < "$BACKUP_SET/caddy-data.tar.gz" \
    || fail "restoring the caddy /data volume failed"

  info "restoring /config"
  "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh caddy \
    -c 'tar -C /config -xzf -' < "$BACKUP_SET/caddy-config.tar.gz" \
    || fail "restoring the caddy /config volume failed"

  info "starting caddy"
  "${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 120 caddy \
    || fail "the caddy container did not become ready"

  printf 'restore: ok caddy\n'
}

case "$MODE" in
  postgres) restore_postgres ;;
  caddy) restore_caddy ;;
esac
