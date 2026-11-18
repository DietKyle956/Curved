#!/usr/bin/env bash
# Production compose stack gate: build the app image through deploy/, boot the
# full stack (Postgres, app, Caddy) as an isolated compose project, and assert
# the deployment contract end to end over TLS. The stack and its volumes are
# always removed; the smoke image is removed unless `--keep` is given.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="deploy/docker-compose.yml"
SMOKE_IMAGE="curved:compose-smoke"
PROJECT_NAME="curved-compose-smoke-$$"
DOMAIN="localhost"

POSTGRES_USER="smoke"
POSTGRES_DB="smoke"

TMP_DIR=""
ENV_FILE=""
CA_FILE=""
SSE_FILE=""
SSE_PID=""
keep=0

usage() {
  cat <<'EOF'
Usage: bash scripts/compose-smoke.sh [--keep]

Builds the app image from the repository root, boots deploy/docker-compose.yml
as a throwaway compose project with a random UI token, random Postgres and
webhook secrets, and free host ports, then verifies the stack through Caddy
over TLS: the SPA shell, the token boundary, the Secure session cookie, the
issue lifecycle, SSE frames, the GitHub webhook route, and the published
ports.

  --keep     Keep the built smoke image (tag: curved:compose-smoke). The
             stack and its volumes are still removed.
  -h, --help Show this message.

The development stack is never touched.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)
      keep=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'compose-smoke: unknown argument %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

fail() {
  printf 'compose-smoke: FAIL %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "$SSE_PID" ]; then
    kill "$SSE_PID" >/dev/null 2>&1 || true
    wait "$SSE_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$ENV_FILE" ] && [ -f "$COMPOSE_FILE" ]; then
    docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
      down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "$keep" -eq 0 ]; then
    docker image rm -f "$SMOKE_IMAGE" >/dev/null 2>&1 || true
  fi
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  return "$status"
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is required"
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose v2 is required"
fi
if ! command -v curl >/dev/null 2>&1; then
  fail "curl is required"
fi
if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 is required to pick free ports and generate secrets"
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  fail "$COMPOSE_FILE is missing"
fi

TMP_DIR="$(mktemp -d)"
ENV_FILE="$TMP_DIR/compose.env"
CA_FILE="$TMP_DIR/root.crt"
SSE_FILE="$TMP_DIR/sse.txt"
umask 077

# Three free high ports, held open until the stack binds them.
if ! ports="$(python3 -c 'import socket
sockets = []
for _ in range(3):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
print(" ".join(str(sock.getsockname()[1]) for sock in sockets))')"; then
  fail "could not pick free host ports"
fi
read -r DB_PORT HTTP_PORT HTTPS_PORT <<< "$ports"

secret() {
  python3 -c 'import secrets
print(secrets.token_hex(24))'
}
POSTGRES_PASSWORD="$(secret)" || fail "failed to generate the Postgres password"
UI_TOKEN="$(secret)" || fail "failed to generate the UI token"
WEBHOOK_SECRET="$(secret)" || fail "failed to generate the webhook secret"

cat > "$ENV_FILE" <<EOF
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=$POSTGRES_DB
CURVED_UI_TOKEN=$UI_TOKEN
GITHUB_WEBHOOK_SECRET=$WEBHOOK_SECRET
CURVED_DOMAIN=$DOMAIN
ACME_EMAIL=
COOKIE_SECURE=1
CURVED_DB_PORT=$DB_PORT
CURVED_HTTP_PORT=$HTTP_PORT
CURVED_HTTPS_PORT=$HTTPS_PORT
CURVED_IMAGE=$SMOKE_IMAGE
EOF
chmod 600 "$ENV_FILE"

COMPOSE=(docker compose -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

base_url="https://$DOMAIN:$HTTPS_PORT"

tls_curl() {
  curl -sS --max-time 30 --cacert "$CA_FILE" \
    --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "$@"
}

tls_status() {
  curl -sS --max-time 30 --cacert "$CA_FILE" \
    --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" \
    -o /dev/null -w '%{http_code}' "$@"
}

printf 'compose-smoke: starting %s (db %s, http %s, https %s)\n' \
  "$PROJECT_NAME" "$DB_PORT" "$HTTP_PORT" "$HTTPS_PORT"
if ! "${COMPOSE[@]}" up -d --build --wait; then
  printf 'compose-smoke: stack did not report healthy; recent logs follow\n' >&2
  "${COMPOSE[@]}" logs --tail=100 >&2 || true
  fail "docker compose up did not report a healthy stack"
fi
printf 'compose-smoke: PASS stack is up and healthy\n'

# Caddy's internal CA only exists after it provisions the localhost site, so
# poke the TLS listener until the root certificate shows up in /data.
ca_ready=0
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt >/dev/null 2>&1; then
    if "${COMPOSE[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$CA_FILE" 2>/dev/null; then
      ca_ready=1
      break
    fi
  fi
  curl -sk -o /dev/null --max-time 5 \
    --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "$base_url/" || true
  sleep 1
done
if [ "$ca_ready" -ne 1 ]; then
  fail "could not read the Caddy internal root CA"
fi
printf 'compose-smoke: PASS Caddy internal root CA extracted\n'

status="$(tls_status "$base_url/" || true)"
[ "$status" = "200" ] || fail "GET / returned ${status:-nothing} (expected 200)"
body="$(tls_curl "$base_url/" || true)"
if ! printf '%s' "$body" | grep -q 'id="root"'; then
  fail "GET / body is missing the SPA root element (id=\"root\")"
fi
printf 'compose-smoke: PASS SPA shell served through Caddy at %s/\n' "$base_url"

status="$(tls_status "$base_url/api/projects" || true)"
[ "$status" = "401" ] || fail "unauthenticated GET /api/projects returned ${status:-nothing} (expected 401)"
printf 'compose-smoke: PASS unauthenticated GET /api/projects is 401\n'

session_headers="$TMP_DIR/session.headers"
status="$(curl -sS --max-time 30 --cacert "$CA_FILE" \
  --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" \
  -D "$session_headers" -o "$TMP_DIR/session.json" -w '%{http_code}' \
  -H 'content-type: application/json' \
  --data-binary "{\"token\":\"$UI_TOKEN\"}" \
  "$base_url/api/session" || true)"
[ "$status" = "200" ] || fail "POST /api/session returned ${status:-nothing} (expected 200)"
set_cookie="$(tr -d '\r' < "$session_headers" | grep -i '^set-cookie:' \
  | sed 's/^[^:]*:[[:space:]]*//' | head -n 1 || true)"
[ -n "$set_cookie" ] || fail "POST /api/session returned no Set-Cookie header"
case "$set_cookie" in
  *curved_session=*) ;;
  *) fail "session cookie does not set the curved_session name: $set_cookie" ;;
esac
printf '%s' "$set_cookie" | grep -q 'HttpOnly' || fail "session cookie is missing HttpOnly: $set_cookie"
printf '%s' "$set_cookie" | grep -q 'SameSite=Lax' || fail "session cookie is missing SameSite=Lax: $set_cookie"
printf '%s' "$set_cookie" | grep -q 'Secure' || fail "session cookie is missing Secure (COOKIE_SECURE=1): $set_cookie"
cookie_pair="${set_cookie%%;*}"
printf 'compose-smoke: PASS POST /api/session issued a Secure HttpOnly SameSite=Lax cookie\n'

status="$(tls_status -H "Cookie: $cookie_pair" "$base_url/api/projects" || true)"
[ "$status" = "200" ] || fail "session-authenticated GET /api/projects returned ${status:-nothing} (expected 200)"
body="$(tls_curl -H "Cookie: $cookie_pair" "$base_url/api/projects" || true)"
if ! printf '%s' "$body" | grep -q '"projects"'; then
  fail "GET /api/projects body is missing the projects payload"
fi
printf 'compose-smoke: PASS session cookie authenticates GET /api/projects\n'

status="$(tls_curl -o "$TMP_DIR/project.json" -w '%{http_code}' -X POST \
  -H "Cookie: $cookie_pair" -H 'content-type: application/json' \
  --data-binary '{"key":"SMK","name":"Smoke"}' \
  "$base_url/api/projects" || true)"
[ "$status" = "201" ] || fail "POST /api/projects returned ${status:-nothing} (expected 201)"
printf 'compose-smoke: PASS created project SMK\n'

status="$(tls_curl -o "$TMP_DIR/issue.json" -w '%{http_code}' -X POST \
  -H "Cookie: $cookie_pair" -H 'content-type: application/json' \
  --data-binary '{"project":"SMK","title":"Through Caddy","status":"todo"}' \
  "$base_url/api/issues" || true)"
[ "$status" = "201" ] || fail "POST /api/issues returned ${status:-nothing} (expected 201)"
body="$(cat "$TMP_DIR/issue.json")"
if ! printf '%s' "$body" | grep -q 'SMK-1'; then
  fail "POST /api/issues did not create SMK-1: $body"
fi
printf 'compose-smoke: PASS created issue SMK-1 through Caddy\n'

body="$(tls_curl -H "Cookie: $cookie_pair" "$base_url/api/ready?project=SMK" || true)"
if ! printf '%s' "$body" | grep -q 'SMK-1'; then
  fail "GET /api/ready?project=SMK does not list SMK-1: $body"
fi
printf 'compose-smoke: PASS GET /api/ready?project=SMK includes SMK-1\n'

body="$(tls_curl -H "Cookie: $cookie_pair" "$base_url/api/issues/SMK-1" || true)"
if ! printf '%s' "$body" | grep -q 'SMK-1'; then
  fail "GET /api/issues/SMK-1 is missing the issue timeline: $body"
fi
printf 'compose-smoke: PASS GET /api/issues/SMK-1 returns the timeline\n'

issues_body="$(tls_curl -H "Cookie: $cookie_pair" "$base_url/api/issues?project=SMK" || true)"
if ! printf '%s' "$issues_body" | grep -q 'SMK-1'; then
  fail "GET /api/issues?project=SMK does not list SMK-1: $issues_body"
fi
printf 'compose-smoke: PASS GET /api/issues?project=SMK lists SMK-1\n'

project_id="$(printf '%s' "$issues_body" | python3 -c 'import json, sys
payload = json.load(sys.stdin)
issues = payload.get("issues") or []
if not issues:
    raise SystemExit("no issues in list response")
print(issues[0]["projectId"])' 2>/dev/null || true)"
case "$project_id" in
  ''|*[!0-9]*) fail "could not read the project id from GET /api/issues: $issues_body" ;;
esac

printf 'compose-smoke: streaming /api/events while commenting on SMK-1\n'
curl -sN --max-time 60 --cacert "$CA_FILE" \
  --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" \
  -H "Cookie: $cookie_pair" "$base_url/api/events" \
  > "$SSE_FILE" 2>"$TMP_DIR/sse.err" &
SSE_PID=$!

sse_ready=0
for _ in $(seq 1 20); do
  if grep -q '^event: ready' "$SSE_FILE" 2>/dev/null; then
    sse_ready=1
    break
  fi
  sleep 1
done
if [ "$sse_ready" -ne 1 ]; then
  printf 'compose-smoke: SSE stream tail follows\n' >&2
  tail -n 40 "$SSE_FILE" >&2 || true
  fail "SSE stream did not emit an event: ready frame"
fi

status="$(tls_curl -o "$TMP_DIR/comment.json" -w '%{http_code}' -X POST \
  -H "Cookie: $cookie_pair" -H 'content-type: application/json' \
  --data-binary '{"body":"Smoke comment through Caddy"}' \
  "$base_url/api/issues/SMK-1/comments" || true)"
[ "$status" = "201" ] || fail "POST /api/issues/SMK-1/comments returned ${status:-nothing} (expected 201)"

sse_changed=0
for _ in $(seq 1 20); do
  if grep -q '^event: issues_changed' "$SSE_FILE" 2>/dev/null \
    && grep -Fxq "data: $project_id" "$SSE_FILE" 2>/dev/null; then
    sse_changed=1
    break
  fi
  sleep 1
done
if [ "$sse_changed" -ne 1 ]; then
  printf 'compose-smoke: SSE stream tail follows\n' >&2
  tail -n 40 "$SSE_FILE" >&2 || true
  fail "SSE stream did not report issues_changed for project $project_id"
fi

if ! python3 - "$SSE_FILE" "$project_id" <<'PY'
import sys

raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
project = sys.argv[2]
frames = [frame for frame in raw.split("\n\n") if frame.strip()]

pairs = []
for frame in frames:
    event = None
    data = []
    for line in frame.splitlines():
        if line.startswith("event:"):
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data.append(line[len("data:"):].strip())
    pairs.append((event, "\n".join(data)))

if not any(event == "ready" for event, _ in pairs):
    raise SystemExit("missing ready frame")
if not any(event == "issues_changed" and data == project for event, data in pairs):
    raise SystemExit(f"missing issues_changed frame for project {project}")
PY
then
  fail "SSE frames do not pair ready with issues_changed($project_id)"
fi

kill "$SSE_PID" >/dev/null 2>&1 || true
wait "$SSE_PID" >/dev/null 2>&1 || true
SSE_PID=""
printf 'compose-smoke: PASS SSE delivered ready and issues_changed(%s) after a comment\n' "$project_id"

status="$(tls_status -X POST -H 'content-type: application/json' \
  --data-binary '{}' "$base_url/webhooks/github" || true)"
[ "$status" = "401" ] || fail "unsigned POST /webhooks/github returned ${status:-nothing} (expected 401)"
printf 'compose-smoke: PASS unsigned POST /webhooks/github is 401 through Caddy\n'

db_binding="$("${COMPOSE[@]}" port db 5432 2>/dev/null || true)"
db_binding="${db_binding//[[:space:]]/}"
[ "$db_binding" = "127.0.0.1:$DB_PORT" ] \
  || fail "db port binding is '${db_binding}' (expected 127.0.0.1:$DB_PORT)"
printf 'compose-smoke: PASS db publishes 127.0.0.1:%s only\n' "$DB_PORT"

# An unpublished port has no host binding: compose reports either no output
# (older versions) or `:0` (current versions).
app_binding="$("${COMPOSE[@]}" port app 4747 2>/dev/null || true)"
app_binding="${app_binding//[[:space:]]/}"
case "$app_binding" in
  ""|":0") ;;
  *) fail "app publishes host port '${app_binding}' (expected compose-network only)" ;;
esac
printf 'compose-smoke: PASS app is not published on the host\n'

printf 'compose-smoke: all checks passed\n'
if [ "$keep" -eq 1 ]; then
  printf 'compose-smoke: kept image %s\n' "$SMOKE_IMAGE"
fi
