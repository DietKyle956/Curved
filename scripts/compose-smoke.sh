#!/usr/bin/env bash
# Production compose stack gate: build the app image through deploy/, boot the
# full stack (Postgres, app, Caddy) as an isolated compose project, and assert
# the deployment contract end to end over TLS. The gate then takes a nightly
# backup set through deploy/backup.sh and restores it through deploy/restore.sh
# (Postgres into a drill database, Caddy in place). The stack and its volumes
# are always removed; the smoke image is removed unless `--keep` is given.
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
over TLS: the HTTP to HTTPS redirect, the SPA shell, compression of the JS
bundle, the HSTS toggle, the token boundary, the Secure session cookie, the
issue lifecycle, SSE frames, the GitHub webhook route, the published ports,
and the backup and restore path (a nightly set taken with deploy/backup.sh,
verified, restored into a drill Postgres database, and restored in place for
Caddy).

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
if ! command -v tar >/dev/null 2>&1; then
  fail "tar is required to inspect the backup archives"
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  fail "sha256sum is required to verify the backup set"
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  fail "$COMPOSE_FILE is missing"
fi
if [ ! -x deploy/backup.sh ] || [ ! -x deploy/restore.sh ]; then
  fail "deploy/backup.sh and deploy/restore.sh must exist and be executable"
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
CURVED_HSTS_MAX_AGE=
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

redirect="$(curl -s --max-time 30 -o /dev/null -w '%{http_code} %{redirect_url}' \
  -H 'Host: localhost' "http://127.0.0.1:$HTTP_PORT/" || true)"
redirect_code="${redirect%% *}"
redirect_url="${redirect#* }"
case "$redirect_code" in
  3??) ;;
  *) fail "GET http://127.0.0.1:$HTTP_PORT/ returned ${redirect_code:-nothing} (expected a 3xx redirect)" ;;
esac
case "$redirect_url" in
  https://*) ;;
  *) fail "HTTP redirect points at '${redirect_url}' (expected an https:// URL)" ;;
esac
printf 'compose-smoke: PASS HTTP redirects to HTTPS with %s\n' "$redirect_code"

hsts_headers="$TMP_DIR/hsts.headers"
tls_curl -D "$hsts_headers" -o /dev/null "$base_url/" || true
if tr -d '\r' < "$hsts_headers" | grep -qi '^strict-transport-security:'; then
  fail "GET / sent Strict-Transport-Security while CURVED_HSTS_MAX_AGE is empty"
fi
printf 'compose-smoke: PASS no Strict-Transport-Security header while CURVED_HSTS_MAX_AGE is empty\n'

# The shell is small enough that Caddy may not compress it; the JS bundle it
# references is what proves the encoder is active.
tls_curl -D "$TMP_DIR/shell.headers" -o "$TMP_DIR/shell.html" \
  -H 'Accept-Encoding: gzip' "$base_url/" || true
shell_encoding="$(tr -d '\r' < "$TMP_DIR/shell.headers" | grep -i '^content-encoding:' \
  | sed 's/^[^:]*:[[:space:]]*//' | head -n 1 || true)"
case "$shell_encoding" in
  ""|identity) shell_body="$(cat "$TMP_DIR/shell.html")" ;;
  gzip) shell_body="$(gzip -dc "$TMP_DIR/shell.html" 2>/dev/null || true)" ;;
  *) fail "GET / used unsupported content-encoding '${shell_encoding}'" ;;
esac
asset_path="$(printf '%s' "$shell_body" | grep -o '/assets/[^"]*\.js' | head -n 1 || true)"
[ -n "$asset_path" ] \
  || fail "GET / did not reference an /assets/...js bundle to test compression"

asset_headers="$TMP_DIR/asset.headers"
status="$(tls_curl -D "$asset_headers" -o /dev/null -w '%{http_code}' \
  -H 'Accept-Encoding: gzip' "$base_url$asset_path" || true)"
[ "$status" = "200" ] || fail "GET $asset_path returned ${status:-nothing} (expected 200)"
asset_encoding="$(tr -d '\r' < "$asset_headers" | grep -i '^content-encoding:' \
  | sed 's/^[^:]*:[[:space:]]*//' | head -n 1 || true)"
case "$asset_encoding" in
  gzip|zstd) ;;
  *) fail "GET $asset_path content-encoding is '${asset_encoding:-none}' (expected gzip or zstd)" ;;
esac
printf 'compose-smoke: PASS Caddy compresses %s with %s\n' "$asset_path" "$asset_encoding"

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
for _ in $(seq 1 5); do
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
  fail "SSE stream did not report issues_changed for project $project_id within 5s"
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

if ! sed -i 's/^CURVED_HSTS_MAX_AGE=.*/CURVED_HSTS_MAX_AGE=31536000/' "$ENV_FILE"; then
  fail "could not enable CURVED_HSTS_MAX_AGE in the smoke env file"
fi
if ! "${COMPOSE[@]}" up -d --no-deps --force-recreate caddy; then
  fail "could not recreate caddy with CURVED_HSTS_MAX_AGE=31536000"
fi
hsts_ready=0
for _ in $(seq 1 20); do
  tls_curl -D "$hsts_headers" -o /dev/null "$base_url/" 2>/dev/null || true
  if tr -d '\r' < "$hsts_headers" \
    | grep -Fxi 'strict-transport-security: max-age=31536000' >/dev/null; then
    hsts_ready=1
    break
  fi
  sleep 1
done
if [ "$hsts_ready" -ne 1 ]; then
  fail "GET / did not send 'Strict-Transport-Security: max-age=31536000' within 20s of enabling CURVED_HSTS_MAX_AGE"
fi
printf 'compose-smoke: PASS HSTS max-age=31536000 served after enabling CURVED_HSTS_MAX_AGE\n'

# Backup and restore leg. deploy/backup.sh nightly archives Postgres and the
# Caddy volumes; the published set must verify on its own. The Postgres restore
# goes into a drill database so the live one keeps serving, then Caddy is
# restored in place and must still answer over TLS. Everything lands under
# TMP_DIR and disappears with the stack in cleanup.
BACKUP_DIR="$TMP_DIR/backups"
backup_set="$BACKUP_DIR/nightly/latest"
backup_log="$TMP_DIR/backup.log"
restore_db="curved_smoke_restore"

if ! ./deploy/backup.sh nightly --output-dir "$BACKUP_DIR" \
  --project "$PROJECT_NAME" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" \
  > "$backup_log" 2>&1; then
  printf 'compose-smoke: backup log follows\n' >&2
  cat "$backup_log" >&2 || true
  fail "deploy/backup.sh nightly failed"
fi
if ! grep -q '^backup: ok ' "$backup_log"; then
  printf 'compose-smoke: backup log follows\n' >&2
  cat "$backup_log" >&2 || true
  fail "deploy/backup.sh nightly did not report 'backup: ok'"
fi

[ -f "$backup_set/manifest.txt" ] || fail "the nightly set has no manifest.txt"
grep -q '^backup_format=1$' "$backup_set/manifest.txt" \
  || fail "manifest.txt does not record backup_format=1"
grep -q '^kind=nightly$' "$backup_set/manifest.txt" \
  || fail "manifest.txt does not record kind=nightly"
grep -q "^postgres_db=$POSTGRES_DB\$" "$backup_set/manifest.txt" \
  || fail "manifest.txt does not record postgres_db=$POSTGRES_DB"
grep -q '^caddy=archived$' "$backup_set/manifest.txt" \
  || fail "manifest.txt does not record caddy=archived"
[ -f "$backup_set/SHA256SUMS" ] || fail "the nightly set has no SHA256SUMS"
if ! (cd "$backup_set" && sha256sum -c --status SHA256SUMS); then
  fail "SHA256SUMS does not verify for the nightly set"
fi
[ -s "$backup_set/postgres.dump" ] || fail "postgres.dump is missing or empty"
for archive in caddy-data.tar.gz caddy-config.tar.gz; do
  [ -s "$backup_set/$archive" ] || fail "$archive is missing or empty"
  if ! archive_listing="$(tar -tzf "$backup_set/$archive")"; then
    fail "tar -tzf $archive failed"
  fi
  case "$archive_listing" in
    *caddy/*) ;;
    *) fail "$archive does not list caddy/" ;;
  esac
done
printf 'compose-smoke: PASS nightly backup set verifies (manifest, SHA256SUMS, dump, caddy archives)\n'

if ! ./deploy/restore.sh postgres "$backup_set" --database "$restore_db" --yes \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" --project "$PROJECT_NAME"; then
  fail "deploy/restore.sh postgres into $restore_db failed"
fi
restored_key="$("${COMPOSE[@]}" exec -T db psql -U "$POSTGRES_USER" -d "$restore_db" \
  -tAc "SELECT key FROM issues WHERE key = 'SMK-1'" 2>/dev/null | tr -d '[:space:]' || true)"
[ "$restored_key" = "SMK-1" ] \
  || fail "the restored $restore_db database does not contain SMK-1 (got '${restored_key:-nothing}')"
printf 'compose-smoke: PASS Postgres restore drill into %s contains SMK-1\n' "$restore_db"

if ! ./deploy/restore.sh caddy "$backup_set" --yes \
  --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" --project "$PROJECT_NAME"; then
  fail "deploy/restore.sh caddy failed"
fi
https_ready=0
for _ in $(seq 1 30); do
  status="$(tls_status "$base_url/" || true)"
  if [ "$status" = "200" ]; then
    https_ready=1
    break
  fi
  sleep 1
done
if [ "$https_ready" -ne 1 ]; then
  fail "GET / did not return 200 within 30s of the Caddy restore (got ${status:-nothing})"
fi
printf 'compose-smoke: PASS Caddy restore kept HTTPS serving 200\n'

printf 'compose-smoke: all checks passed\n'
if [ "$keep" -eq 1 ]; then
  printf 'compose-smoke: kept image %s\n' "$SMOKE_IMAGE"
fi
