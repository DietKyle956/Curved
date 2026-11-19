#!/usr/bin/env bash
# Consistent backup sets for the production Curved stack.
#
# Each run writes one set under <base>/<kind>/<YYYYMMDDTHHMMSSZ>/ holding the
# Postgres custom-format dump, the Caddy data and config volumes, a manifest,
# and SHA256SUMS. The set is staged under a dot directory and only renamed into
# place after every artifact and checksum is written, so a failure never
# disturbs an existing set or the latest symlink.
#
# Usage:
#   deploy/backup.sh [nightly|pre-deploy] [options]
#
# Options:
#   --output-dir DIR     Backup base directory (default $CURVED_BACKUP_DIR or
#                        /srv/curved/backups). Enforced mode 0700.
#   --keep N             Retained sets per kind after publishing (default 7).
#   --tag TAG            Image tag or other revision recorded in the manifest.
#   --label TEXT         Free-form label recorded in the manifest.
#   --env-file PATH      Compose environment file (default deploy/.env).
#   --compose-file PATH  Compose file (default deploy/docker-compose.yml).
#   --project NAME       Compose project name (default curved-prod).
#   --no-prune           Keep every set, including old ones.
#   -h, --help           Show this message and exit.
#
# A nightly backup requires the caddy container to be running because it
# captures the Caddy volumes. A pre-deploy backup skips the volumes with a
# warning when Caddy is absent, which is the case before the first release.
#
# Requires docker compose v2 and flock. Run it from anywhere in the checkout.
set -euo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(dirname -- "$SCRIPT_DIR")

KIND="nightly"
KEEP=7
TAG=""
LABEL=""
ENV_FILE="deploy/.env"
COMPOSE_FILE="deploy/docker-compose.yml"
PROJECT_NAME="curved-prod"
BASE_DIR="${CURVED_BACKUP_DIR:-/srv/curved/backups}"
NO_PRUNE=0
STAGING=""
LOCK_FD=9

usage() {
  cat <<'EOF'
Usage: deploy/backup.sh [nightly|pre-deploy] [options]

Write a consistent backup set of the Postgres database and, when Caddy is
running, the Caddy data and config volumes. The set is staged, checksummed,
and published atomically under <base>/<kind>/<timestamp>, then <base>/<kind>/latest
is pointed at it.

Kinds:
  nightly      Full backup; requires the caddy container to be running.
               This is the default.
  pre-deploy   Full backup; skips the Caddy volumes with a warning when the
               container is not running.

Options:
  --output-dir DIR     Backup base directory (default $CURVED_BACKUP_DIR or
                       /srv/curved/backups). Created with mode 0700.
  --keep N             Retained sets per kind after publishing (default 7,
                       integer >= 1). Oldest sets are removed.
  --tag TAG            Image tag or other revision recorded in the manifest.
  --label TEXT         Free-form label recorded in the manifest.
  --env-file PATH      Compose environment file (default deploy/.env).
  --compose-file PATH  Compose file (default deploy/docker-compose.yml).
  --project NAME       Compose project name (default curved-prod).
  --no-prune           Keep every set.
  -h, --help           Show this message and exit.

The environment file supplies Compose interpolation; POSTGRES_USER and
POSTGRES_DB must be set. Secret values are never printed.

Exit codes: 0 on success, 1 on failure, 2 on usage errors.
EOF
}

argument_error() {
  printf 'backup: %s\n\n' "$1" >&2
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
  printf '%sbackup: error: %s%s\n' "$RED" "${1:-failed}" "$RESET" >&2
  exit 1
}

warn() {
  printf 'backup: warning: %s\n' "$1" >&2
}

info() {
  printf 'backup: %s\n' "$1"
}

cleanup() {
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
    rm -rf -- "$STAGING"
  fi
}
trap cleanup EXIT

cd "$REPO_ROOT"

# Parse arguments. The kind may only be the first word; every other positional
# argument is rejected so a typo never silently changes the backup kind.
case "${1:-}" in
  nightly | pre-deploy)
    KIND=$1
    shift
    ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      BASE_DIR=$2
      shift 2
      ;;
    --keep)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a count"
      fi
      KEEP=$2
      shift 2
      ;;
    --tag)
      if [ "$#" -lt 2 ]; then
        argument_error "$1 requires a value"
      fi
      TAG=$2
      shift 2
      ;;
    --label)
      if [ "$#" -lt 2 ]; then
        argument_error "$1 requires a value"
      fi
      LABEL=$2
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
        argument_error "$1 requires a name"
      fi
      PROJECT_NAME=$2
      shift 2
      ;;
    --no-prune)
      NO_PRUNE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      argument_error "unknown argument $1"
      ;;
    *)
      argument_error "unexpected argument $1"
      ;;
  esac
done

case "$KEEP" in
  '' | *[!0-9]*) argument_error "--keep must be an integer, got '$KEEP'" ;;
esac
if [ "$KEEP" -lt 1 ]; then
  argument_error "--keep must be at least 1"
fi

[ -n "$PROJECT_NAME" ] || argument_error "--project must not be empty"

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v flock >/dev/null 2>&1 || fail "flock is required"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

ENV_FILE=$(realpath -m -- "$ENV_FILE")
COMPOSE_FILE=$(realpath -m -- "$COMPOSE_FILE")
BASE_DIR=$(realpath -m -- "$BASE_DIR")

[ -r "$ENV_FILE" ] || fail "environment file $ENV_FILE is missing or unreadable"
[ -f "$COMPOSE_FILE" ] || fail "compose file $COMPOSE_FILE is missing"

# Load the environment file exactly as Compose does. Values become part of this
# environment only, and nothing secret is printed.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ -n "${POSTGRES_USER:-}" ] || fail "POSTGRES_USER is not set in $ENV_FILE"
[ -n "${POSTGRES_DB:-}" ] || fail "POSTGRES_DB is not set in $ENV_FILE"

COMPOSE=(docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# The base directory is private: dumps contain every row of the database.
install -d -m 0700 -- "$BASE_DIR"
chmod 0700 -- "$BASE_DIR"

exec 9>"$BASE_DIR/.backup.lock"
flock -n 9 || fail "another backup is already running (lock $BASE_DIR/.backup.lock)"

KIND_DIR="$BASE_DIR/$KIND"
install -d -m 0700 -- "$KIND_DIR"

TS=$(date -u +%Y%m%dT%H%M%SZ)
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Pick the first free set name: the timestamp, then -2, -3, ... so two backups
# within the same second never overwrite each other.
NAME=$TS
suffix=1
while [ -e "$KIND_DIR/$NAME" ]; do
  suffix=$((suffix + 1))
  NAME="$TS-$suffix"
done

GIT_SHA="unknown"
if command -v git >/dev/null 2>&1; then
  GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)
  [ -n "$GIT_SHA" ] || GIT_SHA="unknown"
fi

HOSTNAME_VALUE=$(hostname 2>/dev/null || true)
[ -n "$HOSTNAME_VALUE" ] || HOSTNAME_VALUE="unknown"

# Decide whether the caddy volumes are part of this set.
caddy_running() {
  local ids
  ids=$("${COMPOSE[@]}" ps -q caddy) || fail "could not query the caddy container"
  [ -n "$ids" ]
}

CADDY_STATE="skipped"
if caddy_running; then
  CADDY_STATE="archived"
elif [ "$KIND" = "nightly" ]; then
  fail "the caddy container is not running; a nightly backup needs it"
else
  warn "the caddy container is not running; skipping the Caddy volumes"
fi

STAGING="$KIND_DIR/.tmp.$$.$TS"
install -d -m 0700 -- "$STAGING"

info "backing up $POSTGRES_DB as $POSTGRES_USER into $KIND_DIR/$NAME"

# Postgres first: it is the artifact that must always be present.
if ! "${COMPOSE[@]}" exec -T db pg_dump \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -Z 9 --no-owner --no-privileges >"$STAGING/postgres.dump"; then
  fail "pg_dump failed for database $POSTGRES_DB"
fi
[ -s "$STAGING/postgres.dump" ] || fail "pg_dump produced an empty dump"

ARTIFACTS=(postgres.dump)

if [ "$CADDY_STATE" = "archived" ]; then
  if ! "${COMPOSE[@]}" exec -T caddy tar -C /data -czf - . >"$STAGING/caddy-data.tar.gz"; then
    fail "archiving the caddy data volume failed"
  fi
  [ -s "$STAGING/caddy-data.tar.gz" ] || fail "the caddy data archive is empty"
  ARTIFACTS+=(caddy-data.tar.gz)

  if ! "${COMPOSE[@]}" exec -T caddy tar -C /config -czf - . >"$STAGING/caddy-config.tar.gz"; then
    fail "archiving the caddy config volume failed"
  fi
  [ -s "$STAGING/caddy-config.tar.gz" ] || fail "the caddy config archive is empty"
  ARTIFACTS+=(caddy-config.tar.gz)
fi

# The manifest is one key=value per line in a fixed order; restore.sh reads it.
{
  printf 'backup_format=1\n'
  printf 'kind=%s\n' "$KIND"
  printf 'created_at=%s\n' "$CREATED_AT"
  printf 'git_sha=%s\n' "$GIT_SHA"
  printf 'hostname=%s\n' "$HOSTNAME_VALUE"
  printf 'postgres_user=%s\n' "$POSTGRES_USER"
  printf 'postgres_db=%s\n' "$POSTGRES_DB"
  printf 'caddy=%s\n' "$CADDY_STATE"
  printf 'tag=%s\n' "$TAG"
  printf 'label=%s\n' "$LABEL"
} >"$STAGING/manifest.txt"

# Checksums cover every stored artifact and nothing else.
(
  cd "$STAGING"
  sha256sum "${ARTIFACTS[@]}" >SHA256SUMS
)

chmod 0600 -- "$STAGING/manifest.txt" "$STAGING/SHA256SUMS"
for artifact in "${ARTIFACTS[@]}"; do
  chmod 0600 -- "$STAGING/$artifact"
done

# Publish atomically inside the same filesystem, then point latest at it. After
# the rename the staging trap must not touch the published set.
mv -- "$STAGING" "$KIND_DIR/$NAME"
STAGING=""

ln -sfn -- "$NAME" "$KIND_DIR/latest"

FINAL="$KIND_DIR/$NAME"
info "published $FINAL"

# Retention runs strictly after a successful publish and never touches the set
# just written or the latest symlink.
if [ "$NO_PRUNE" -eq 1 ]; then
  info "pruning disabled; keeping every set"
else
  kept=0
  while IFS= read -r dirname; do
    [ -n "$dirname" ] || continue
    # Only names this script produces may ever be removed.
    case "$dirname" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z | \
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9]*)
        ;;
      *) continue ;;
    esac
    kept=$((kept + 1))
    if [ "$kept" -le "$KEEP" ]; then
      continue
    fi
    [ -d "$KIND_DIR/$dirname" ] || continue
    [ ! -L "$KIND_DIR/$dirname" ] || continue
    rm -rf -- "$KIND_DIR/$dirname"
    info "pruned $KIND_DIR/$dirname"
  done <<EOF
$(find "$KIND_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort -r)
EOF
fi

printf 'backup: ok %s\n' "$FINAL"
