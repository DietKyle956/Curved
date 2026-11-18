#!/usr/bin/env bash
# Production image contract gate: boot the local development Postgres, build
# the image from `.`, run it against the local `curved` database, and assert
# that the runtime serves the SPA, enforces the UI token, migrates, runs as a
# non-root user, and ships only the runtime files. Every container is removed
# on exit; the image is removed unless `--keep` is given.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE="curved:container-smoke"
DATABASE_URL="postgres://curved:curved@127.0.0.1:55432/curved"
UI_TOKEN="container-smoke-token"
READY_TIMEOUT_SECONDS=30

container=""
keep=0
build_only=0
platform=""

usage() {
  cat <<'EOF'
Usage: bash scripts/container-smoke.sh [--platform <platform>] [--keep] [--build-only]

Builds the production image from the repository root, runs it against the
local development Postgres (scripts/db.sh), and verifies the image contract:
the SPA shell, the 401/200 API token boundary, migrations, the non-root user,
and the minimal runtime file set.

  --platform <platform>  Build and run for this platform, e.g. linux/arm64.
                         Requires binfmt emulation when it differs from the host.
  --keep                 Keep the built image (tag: curved:container-smoke).
  --build-only           Build the image (and `--platform` image) and stop after
                         a successful build; skip the runtime assertions.
  -h, --help             Show this message.

Environment:
  SMOKE_PORT             Host port for the container server. Defaults to a
                         free high port chosen on 127.0.0.1.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        printf 'container-smoke: --platform requires a value\n\n' >&2
        usage >&2
        exit 2
      fi
      platform="$2"
      shift 2
      ;;
    --platform=*)
      platform="${1#*=}"
      if [ -z "$platform" ]; then
        printf 'container-smoke: --platform requires a value\n\n' >&2
        usage >&2
        exit 2
      fi
      shift
      ;;
    --keep)
      keep=1
      shift
      ;;
    --build-only)
      build_only=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'container-smoke: unknown argument %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

fail() {
  printf 'container-smoke: FAIL %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "$container" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if [ "$keep" -eq 0 ]; then
    docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  fi
  return "$status"
}
trap cleanup EXIT

if [ -n "${SMOKE_PORT:-}" ]; then
  port="$SMOKE_PORT"
else
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'container-smoke: python3 is required to pick a free port; set SMOKE_PORT instead\n' >&2
    exit 2
  fi
  port="$(python3 -c 'import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])')"
fi

case "$port" in
  ''|*[!0-9]*)
    printf 'container-smoke: SMOKE_PORT must be an integer between 1 and 65535, got "%s"\n' "$port" >&2
    exit 2
    ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  printf 'container-smoke: SMOKE_PORT must be an integer between 1 and 65535, got "%s"\n' "$port" >&2
  exit 2
fi

platform_args=()
if [ -n "$platform" ]; then
  platform_args=(--platform "$platform")
fi

printf 'container-smoke: starting Postgres and applying migrations\n'
bash scripts/db.sh

printf 'container-smoke: building image %s\n' "$IMAGE"
if [ -n "$platform" ]; then
  docker buildx build --load --platform "$platform" -t "$IMAGE" .
else
  docker build -t "$IMAGE" .
fi

if [ "$build_only" -eq 1 ]; then
  built_for="${platform:-$(uname -m)}"
  printf 'container-smoke: PASS image built for %s\n' "$built_for"
  exit 0
fi

container="curved-smoke-$$"
base_url="http://127.0.0.1:$port"
printf 'container-smoke: starting %s on %s\n' "$container" "$base_url"
docker run --detach --rm --name "$container" --network=host \
  "${platform_args[@]}" \
  --env "DATABASE_URL=$DATABASE_URL" \
  --env "PORT=$port" \
  --env "CURVED_UI_TOKEN=$UI_TOKEN" \
  "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 "$READY_TIMEOUT_SECONDS"); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]; then
    break
  fi
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$base_url/" || true)" = "200" ]; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  printf 'container-smoke: server did not answer on %s within %ss; container logs follow\n' \
    "$base_url" "$READY_TIMEOUT_SECONDS" >&2
  docker logs "$container" >&2 || true
  fail "server did not become ready at $base_url"
fi

status="$(curl -s -o /dev/null -w '%{http_code}' "$base_url/" || true)"
[ "$status" = "200" ] || fail "GET / returned $status (expected 200)"
body="$(curl -s "$base_url/" || true)"
if ! printf '%s' "$body" | grep -q 'id="root"'; then
  fail "GET / body is missing the SPA root element (id=\"root\")"
fi
printf 'container-smoke: PASS SPA shell served at %s/\n' "$base_url"

status="$(curl -s -o /dev/null -w '%{http_code}' "$base_url/api/projects" || true)"
[ "$status" = "401" ] || fail "unauthenticated GET /api/projects returned $status (expected 401)"
printf 'container-smoke: PASS unauthenticated GET /api/projects is 401\n'

status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $UI_TOKEN" "$base_url/api/projects" || true)"
[ "$status" = "200" ] || fail "authenticated GET /api/projects returned $status (expected 200)"
body="$(curl -s -H "Authorization: Bearer $UI_TOKEN" "$base_url/api/projects" || true)"
if ! printf '%s' "$body" | grep -q '"projects"'; then
  fail "authenticated GET /api/projects body is missing the projects payload"
fi
printf 'container-smoke: PASS authenticated GET /api/projects is 200 with projects\n'

printf 'container-smoke: checking migrations inside the image\n'
if ! migrate_output="$(docker run --rm "${platform_args[@]}" --network=host \
  --env "DATABASE_URL=$DATABASE_URL" \
  "$IMAGE" node src/composition/migrate.ts 2>&1)"; then
  printf '%s\n' "$migrate_output" >&2
  fail "migration run inside the image failed"
fi
if ! printf '%s' "$migrate_output" | grep -q 'already up to date'; then
  printf '%s\n' "$migrate_output" >&2
  fail "migration run did not report 'already up to date'"
fi
printf 'container-smoke: PASS migrations report already up to date\n'

uid="$(docker run --rm "${platform_args[@]}" "$IMAGE" id -u)"
uid="${uid//[[:space:]]/}"
[ "$uid" != "0" ] || fail "container runs as root (uid 0)"
printf 'container-smoke: PASS container runs as non-root (uid %s)\n' "$uid"

if ! docker run --rm "${platform_args[@]}" "$IMAGE" sh -c '
set -e
for path in /app/.env /app/.env.example /app/test /app/scripts /app/docker-compose.yml /app/.github /app/deploy /app/Caddyfile /app/Dockerfile; do
  if [ -e "$path" ]; then
    printf "unexpected %s in image\n" "$path" >&2
    exit 1
  fi
done
for path in /app/web/dist/index.html /app/migrations/0001_projects.sql; do
  if [ ! -e "$path" ]; then
    printf "missing %s in image\n" "$path" >&2
    exit 1
  fi
done
'; then
  fail "runtime file set does not match the image contract"
fi
printf 'container-smoke: PASS runtime file set is minimal and complete\n'

printf 'container-smoke: all checks passed\n'
if [ "$keep" -eq 1 ]; then
  printf 'container-smoke: kept image %s\n' "$IMAGE"
fi
