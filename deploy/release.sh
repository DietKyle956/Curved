#!/usr/bin/env bash
# One-command release for the production Curved stack on its host.
#
# The flow is: bring the database up, build the image for the current HEAD,
# apply migrations through a one-shot container, recreate only the app, reload
# Caddy, then prove the public HTTPS API answers with the configured UI token.
# Only a release that passes (or one whose probe was explicitly or first-time
# skipped) moves curved:latest and records the release state.
#
# Usage:
#   deploy/release.sh [--skip-public-probe] [--require-public-probe]
#                     [--state-file PATH] [--env-file PATH]
#                     [--compose-file PATH]
#   deploy/release.sh rollback <tag> [--skip-public-probe]
#                     [--state-file PATH] [--env-file PATH]
#                     [--compose-file PATH]
#
# This script never tears the stack down; it only creates and updates the db,
# app, and Caddy containers. Volumes and data are left untouched.
#
# Environment:
#   CURVED_RELEASE_STATE    Release state file (default /srv/curved/release-state).
#   RELEASE_PROBE_ATTEMPTS  Public probe attempts (default 30).
#   RELEASE_PROBE_INTERVAL  Seconds between attempts (default 2).
#
# The environment file supplies Compose interpolation and the container
# environment. Secret values are never printed.
set -euo pipefail

PROJECT_NAME="curved-prod"
MODE="deploy"
TAG=""
SKIP_PUBLIC_PROBE=0
REQUIRE_PUBLIC_PROBE=0
ENV_FILE="deploy/.env"
COMPOSE_FILE="deploy/docker-compose.yml"
STATE_FILE="${CURVED_RELEASE_STATE:-/srv/curved/release-state}"
PROBE_ATTEMPTS="${RELEASE_PROBE_ATTEMPTS:-30}"
PROBE_INTERVAL="${RELEASE_PROBE_INTERVAL:-2}"
TMP_DIR=""

usage() {
  cat <<'EOF'
Usage: deploy/release.sh [options]
       deploy/release.sh rollback <tag> [options]

Build, migrate, and release the current HEAD to the production Compose stack,
or roll back to an existing image tag. The release is tagged curved:<short>
and curved:latest only after the public endpoint passes.

Deploy options:
  --skip-public-probe     Skip the HTTPS probe with a warning. The release is
                          still tagged and recorded.
  --require-public-probe  Enforce the HTTPS probe even when no release state
                          exists (first release included).
  --state-file PATH       Release state file (default $CURVED_RELEASE_STATE or
                          /srv/curved/release-state). Its absence means "first
                          release", which skips the probe unless required.
  --env-file PATH         Compose environment file (default deploy/.env).
  --compose-file PATH     Compose file (default deploy/docker-compose.yml).
  -h, --help              Show this message and exit.

Rollback options:
  --skip-public-probe     Skip the HTTPS probe with a warning.
  --state-file PATH       Release state file.
  --env-file PATH         Compose environment file.
  --compose-file PATH     Compose file.

Deploy runs, in order: database up and healthy, build curved:<short>, one-shot
migrations, app recreation and health, Caddy reload, public probe, then the
curved:latest tag and the state file. A failed migration stops immediately and
leaves the previous app serving. Rollback never runs migrations and warns that
a non-backward-compatible migration needs a database restore instead.

Requires docker compose v2 and git. Run it from anywhere inside the checkout.
EOF
}

argument_error() {
  printf 'release: %s\n\n' "$1" >&2
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
  printf '%srelease: error: %s%s\n' "$RED" "${1:-failed}" "$RESET" >&2
  exit 1
}

warn() {
  printf 'release: warning: %s\n' "$1" >&2
}

info() {
  printf 'release: %s\n' "$1"
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

# Parse arguments. `rollback` may only be the first word; every other argument
# is an option, so `deploy/release.sh rollback <tag> --env-file ...` works.
if [ "${1:-}" = "rollback" ]; then
  MODE="rollback"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-public-probe)
      SKIP_PUBLIC_PROBE=1
      shift
      ;;
    --require-public-probe)
      if [ "$MODE" = "rollback" ]; then
        argument_error "--require-public-probe is only valid for a deploy"
      fi
      REQUIRE_PUBLIC_PROBE=1
      shift
      ;;
    --state-file)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      STATE_FILE=$2
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
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      argument_error "unknown argument $1"
      ;;
    *)
      if [ "$MODE" = "rollback" ] && [ -z "$TAG" ]; then
        TAG=$1
        shift
      else
        argument_error "unexpected argument $1"
      fi
      ;;
  esac
done

if [ "$SKIP_PUBLIC_PROBE" -eq 1 ] && [ "$REQUIRE_PUBLIC_PROBE" -eq 1 ]; then
  argument_error "--skip-public-probe and --require-public-probe are mutually exclusive"
fi

if [ "$MODE" = "rollback" ] && [ -z "$TAG" ]; then
  argument_error "rollback requires an image tag"
fi

case "$PROBE_ATTEMPTS" in
  '' | *[!0-9]*) fail "RELEASE_PROBE_ATTEMPTS must be a positive integer, got '$PROBE_ATTEMPTS'" ;;
esac
if [ "$PROBE_ATTEMPTS" -lt 1 ]; then
  fail "RELEASE_PROBE_ATTEMPTS must be at least 1"
fi
case "$PROBE_INTERVAL" in
  '' | *[!0-9]*) fail "RELEASE_PROBE_INTERVAL must be a non-negative integer, got '$PROBE_INTERVAL'" ;;
esac

command -v git >/dev/null 2>&1 || fail "git is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || true
[ -n "$REPO_ROOT" ] || fail "not inside a git checkout; run this from the repository"
cd "$REPO_ROOT"

ENV_FILE=$(realpath -m -- "$ENV_FILE")
COMPOSE_FILE=$(realpath -m -- "$COMPOSE_FILE")
STATE_FILE=$(realpath -m -- "$STATE_FILE")

[ -r "$ENV_FILE" ] || fail "environment file $ENV_FILE is missing or unreadable"
[ -f "$COMPOSE_FILE" ] || fail "compose file $COMPOSE_FILE is missing"

# Load the environment file exactly as Compose does, so the probe and the state
# use the same domain and token. Values become part of this environment only.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ -n "${CURVED_UI_TOKEN:-}" ] || fail "CURVED_UI_TOKEN is not set in $ENV_FILE"
DOMAIN="${CURVED_DOMAIN:-localhost}"

COMPOSE=(docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

write_state() {
  local tag=$1
  local sha=$2
  local dir tmp
  dir=$(dirname -- "$STATE_FILE")
  mkdir -p -- "$dir" || fail "cannot create state directory $dir"
  tmp=$(mktemp "$dir/.release-state.XXXXXX") \
    || fail "cannot create a temporary state file in $dir"
  {
    printf 'tag=%s\n' "$tag"
    printf 'sha=%s\n' "$sha"
    printf 'at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"
  mv -f -- "$tmp" "$STATE_FILE" || fail "cannot write state file $STATE_FILE"
}

# Extract Caddy's internal root CA once per run when ACME is not configured, so
# curl can verify the localhost-style certificate without touching the host
# trust store. The path lands in PROBE_CA_FILE and is empty under ACME.
PROBE_CA_FILE=""
prepare_probe_ca() {
  PROBE_CA_FILE=""
  if [ -n "${ACME_EMAIL:-}" ]; then
    return 0
  fi
  if [ -z "$TMP_DIR" ]; then
    TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/curved-release.XXXXXX") \
      || fail "cannot create a temporary directory"
  fi
  local ca="$TMP_DIR/caddy-root.crt"
  if ! "${COMPOSE[@]}" exec -T caddy \
    cat /data/caddy/pki/authorities/local/root.crt > "$ca" 2>/dev/null; then
    fail "could not extract the Caddy internal root CA from the caddy container"
  fi
  if [ ! -s "$ca" ]; then
    fail "the extracted Caddy internal root CA is empty"
  fi
  PROBE_CA_FILE=$ca
}

probe_public_endpoint() {
  local attempt=1
  local status
  local args=(-sS -o /dev/null -w '%{http_code}' --max-time 10)

  prepare_probe_ca
  if [ -n "$PROBE_CA_FILE" ]; then
    args+=(--cacert "$PROBE_CA_FILE")
  fi

  while :; do
    status=$(curl "${args[@]}" \
      -H "Authorization: Bearer ${CURVED_UI_TOKEN}" \
      "https://${DOMAIN}/api/projects" 2>/dev/null || true)
    if [ "$status" = "200" ]; then
      return 0
    fi
    if [ "$attempt" -ge "$PROBE_ATTEMPTS" ]; then
      return 1
    fi
    attempt=$((attempt + 1))
    sleep "$PROBE_INTERVAL"
  done
}

# Decide whether this run probes the public endpoint. The first release has no
# state file and no trusted baseline to compare against, so it skips unless the
# operator demands the probe.
probe_gate() {
  if [ "$SKIP_PUBLIC_PROBE" -eq 1 ]; then
    warn "public probe skipped (--skip-public-probe); the release is tagged and recorded anyway"
    return 0
  fi
  if [ ! -f "$STATE_FILE" ] && [ "$REQUIRE_PUBLIC_PROBE" -eq 0 ]; then
    warn "no release state at $STATE_FILE: this is the first release, so the public probe is skipped"
    warn "use --require-public-probe to enforce the HTTPS check on the first release"
    return 0
  fi

  info "probing https://${DOMAIN}/api/projects (up to $PROBE_ATTEMPTS attempts)"
  if probe_public_endpoint; then
    info "public probe ok"
    return 0
  fi
  fail "public probe failed: https://${DOMAIN}/api/projects did not return 200 after $PROBE_ATTEMPTS attempts; curved:latest and the release state were left untouched"
}

deploy() {
  local short
  local image

  short=$(git rev-parse --short HEAD 2>/dev/null) || true
  [ -n "$short" ] || fail "could not resolve HEAD with git rev-parse"
  image="curved:$short"

  info "releasing $image from $REPO_ROOT"

  info "starting the database"
  "${COMPOSE[@]}" up -d --wait --wait-timeout 300 db \
    || fail "the database did not become healthy"

  info "building $image"
  CURVED_IMAGE="$image" "${COMPOSE[@]}" build app \
    || fail "building $image failed"

  info "applying migrations with $image"
  if ! CURVED_IMAGE="$image" "${COMPOSE[@]}" run --rm --no-deps -T app \
    node src/composition/migrate.ts; then
    printf '%srelease: error: migrations failed; the previous app is still serving, and no container was recreated%s\n' \
      "$RED" "$RESET" >&2
    exit 1
  fi

  info "recreating the app with $image"
  CURVED_IMAGE="$image" "${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 600 app \
    || fail "the app container did not become healthy"

  info "reloading caddy"
  "${COMPOSE[@]}" up -d --no-deps caddy \
    || fail "the caddy container did not start"

  probe_gate

  info "tagging curved:latest"
  docker tag "$image" curved:latest || fail "could not tag curved:latest"

  write_state "$image" "$short"
  printf 'release: ok %s\n' "$short"
}

rollback() {
  local image=$TAG
  local sha

  case "$image" in
    curved:*) ;;
    *) image="curved:$image" ;;
  esac
  sha=${image#curved:}

  docker image inspect "$image" >/dev/null 2>&1 \
    || fail "image $image is not present on this host; build or pull it first"

  warn "a rollback only swaps the image; if the newer release applied a migration that is not backward compatible, restore the database instead"
  info "rolling back to $image"

  CURVED_IMAGE="$image" "${COMPOSE[@]}" up -d --no-deps --wait app \
    || fail "the app container did not become healthy"

  "${COMPOSE[@]}" up -d --no-deps caddy \
    || fail "the caddy container did not start"

  probe_gate

  write_state "$image" "$sha"
  printf 'release: ok %s\n' "$sha"
}

if [ "$MODE" = "rollback" ]; then
  rollback
else
  deploy
fi
