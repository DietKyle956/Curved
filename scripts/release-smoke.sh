#!/usr/bin/env bash
# Release gate: exercise deploy/release.sh end to end against stub binaries in a
# throwaway PATH, so no Docker daemon, database, image build, or network is
# touched. Covers deploy ordering, the pre-deploy backup (ordering before the
# build and migrations, a published and verifiable set, and a failing backup
# that changes nothing), migration failure isolation, first-release probe skip,
# probe failure on a later release, a later passing release, the explicit probe
# skip, rollback, token secrecy, and the no-teardown rule. It also covers the
# public TLS probe: a matching HSTS header passes, while a missing or mismatched
# Strict-Transport-Security header fails without moving curved:latest or
# writing state. The internal (local CA) probe still passes when the endpoint
# sends no HSTS header.
#
# The real deploy/backup.sh runs against CURVED_BACKUP_DIR inside the temp dir,
# and every docker call it makes is answered by the same stub.
#
# Stub knobs, set in the environment of a scenario:
#   SMOKE_CURL_FAIL=1             curl exits 7 on every probe (connection failure)
#   SMOKE_CURL_STATUS=N           curl answers HTTP N and writes a synthetic
#                                 header block for -D (default 200)
#   SMOKE_CURL_HSTS=VALUE         value of the Strict-Transport-Security
#                                 response header; absent when unset
#   SMOKE_DOCKER_FAIL=SUBSTRING   docker exits 1 when its joined args contain SUBSTRING
#                                 (for example pg_dump or migrate.ts)
#   SMOKE_DOCKER_MISSING_IMAGE=TAG
#                                 docker image inspect TAG fails
#
# Each scenario's stub invocations are logged under <tmp>/logs/<scenario>/
# (docker.log, curl.log, order.log); release stdout and stderr go to
# <tmp>/out/<scenario>.log. PASS lines name each assertion; the first failed
# assertion prints FAIL and exits 1.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="$ROOT_DIR/deploy/release.sh"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.yml"
SHORT="abc1234"
ROLLBACK_SHA="def5678"
TOKEN="smoke-ui-token-9f2c4b7d1a6e"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/curved-release-smoke.XXXXXX")
cleanup() {
  local status=$?
  rm -rf -- "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'release-smoke: FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS %s\n' "$1"
}

[ -f "$RELEASE" ] || fail "deploy/release.sh is missing"
[ -x "$RELEASE" ] || fail "deploy/release.sh is not executable"
bash -n "$RELEASE" || fail "deploy/release.sh does not parse (bash -n)"
pass "deploy/release.sh is executable and parses"

STUB_DIR="$TMP_DIR/bin"
mkdir -p "$STUB_DIR" "$TMP_DIR/repo" "$TMP_DIR/out" "$TMP_DIR/state"

cat > "$STUB_DIR/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "rev-parse --show-toplevel") printf '%s\n' "$STUB_REPO_DIR" ;;
  "rev-parse --short HEAD") printf '%s\n' "$STUB_SHORT_SHA" ;;
esac
exit 0
STUB

cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
# Fake docker: logs every invocation, simulates failures declared by the
# SMOKE_DOCKER_FAIL and SMOKE_DOCKER_MISSING_IMAGE knobs, and answers the calls
# deploy/backup.sh makes (compose version, ps -q caddy, pg_dump, caddy tar)
# plus the Caddy CA extraction with deterministic bytes.
set -uo pipefail
line="$*"
printf 'docker CURVED_IMAGE=%s %s\n' "${CURVED_IMAGE:-}" "$line" >> "$STUB_LOG/docker.log"
printf 'docker CURVED_IMAGE=%s %s\n' "${CURVED_IMAGE:-}" "$line" >> "$STUB_LOG/order.log"

if [ -n "${SMOKE_DOCKER_FAIL:-}" ] && [[ "$line" == *"$SMOKE_DOCKER_FAIL"* ]]; then
  printf 'docker: simulated failure (%s)\n' "$SMOKE_DOCKER_FAIL" >&2
  exit 1
fi

if [ "${1:-}" = "--version" ] || [ "${1:-}" = "version" ]; then
  printf 'Docker version 27.3.1, build smoke\n'
  exit 0
fi

if [ "${1:-}" = "compose" ] && [ "${2:-}" = "version" ]; then
  case " $line " in
    *" --short "*)
      printf '2.29.1\n'
      ;;
    *)
      printf 'Docker Compose version v2.29.1\n'
      ;;
  esac
  exit 0
fi

if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then
  if [ -n "${SMOKE_DOCKER_MISSING_IMAGE:-}" ] && [ "${3:-}" = "$SMOKE_DOCKER_MISSING_IMAGE" ]; then
    exit 1
  fi
  exit 0
fi

if [ "${1:-}" = "compose" ]; then
  case " $line " in
    *" exec -T caddy cat "*)
      printf -- '-----BEGIN CERTIFICATE-----\nSMOKE-ROOT-CA\n-----END CERTIFICATE-----\n'
      ;;
    *" ps -q caddy "* | *" ps --quiet caddy "*)
      printf 'smoke-caddy-id\n'
      ;;
    *" pg_dump "*)
      printf 'SMOKE-PG-DUMP-BYTES\n'
      ;;
    *" exec -T caddy tar "*)
      printf 'SMOKE-CADDY-ARCHIVE-BYTES\n'
      ;;
  esac
fi
exit 0
STUB

cat > "$STUB_DIR/curl" <<'STUB'
#!/usr/bin/env bash
# Fake curl: logs the request (so the assertion can read the probe URL and
# header), honors -D by writing a realistic response header block, and returns
# SMOKE_CURL_STATUS (default 200) unless SMOKE_CURL_FAIL asks for a connection
# failure. SMOKE_CURL_HSTS, when non-empty, becomes the value of the
# Strict-Transport-Security response header; otherwise that header is absent.
set -uo pipefail
line="$*"
printf 'curl %s\n' "$line" >> "$STUB_LOG/curl.log"
printf 'curl %s\n' "$line" >> "$STUB_LOG/order.log"

header_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -D)
      header_file="${2:-}"
      shift
      [ "$#" -gt 0 ] && shift
      ;;
    -D*)
      header_file="${1#-D}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ -n "${SMOKE_CURL_FAIL:-}" ]; then
  printf 'curl: (7) simulated connection failure\n' >&2
  exit 7
fi

status="${SMOKE_CURL_STATUS:-200}"
if [ -n "$header_file" ]; then
  {
    printf 'HTTP/2 %s\n' "$status"
    printf 'content-type: application/json\n'
    printf 'server: caddy\n'
    printf 'date: Wed, 19 Nov 2026 00:00:00 GMT\n'
    if [ -n "${SMOKE_CURL_HSTS:-}" ]; then
      printf 'strict-transport-security: %s\n' "$SMOKE_CURL_HSTS"
    fi
    printf '\n'
  } > "$header_file"
fi

printf '%s' "$status"
exit 0
STUB

cat > "$STUB_DIR/sleep" <<'STUB'
#!/usr/bin/env bash
# Fake sleep: the probe retry interval must never slow the gate down.
exit 0
STUB

chmod +x "$STUB_DIR/git" "$STUB_DIR/docker" "$STUB_DIR/curl" "$STUB_DIR/sleep"

export PATH="$STUB_DIR:$PATH"
export STUB_REPO_DIR="$TMP_DIR/repo"
export STUB_SHORT_SHA="$SHORT"
export RELEASE_PROBE_ATTEMPTS=3
export RELEASE_PROBE_INTERVAL=0

ENV_FILE="$TMP_DIR/release.env"
cat > "$ENV_FILE" <<EOF
POSTGRES_USER=smoke
POSTGRES_PASSWORD=smoke
POSTGRES_DB=smoke
CURVED_UI_TOKEN=$TOKEN
GITHUB_WEBHOOK_SECRET=smoke-webhook-secret
CURVED_DOMAIN=release.test
ACME_EMAIL=
COOKIE_SECURE=1
EOF
chmod 600 "$ENV_FILE"

# The release script runs the real deploy/backup.sh; keep every set it publishes
# inside the throwaway tree so the host filesystem and /srv are untouched.
export CURVED_BACKUP_DIR="$TMP_DIR/backups"

COMMON=(--env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE")

seed_state() {
  mkdir -p "$(dirname -- "$1")"
  printf 'tag=curved:prev000\nsha=prev000\nat=2020-01-01T00:00:00Z\n' > "$1"
}

new_logdir() {
  LOGDIR="$TMP_DIR/logs/$1"
  mkdir -p "$LOGDIR"
  export STUB_LOG="$LOGDIR"
}

OUT=""
RC=0
run_release() {
  local name=$1
  shift
  OUT="$TMP_DIR/out/$name.log"
  RC=0
  "$RELEASE" "$@" > "$OUT" 2>&1 || RC=$?
}

LINE=""
require_line() {
  local what=$1
  local pat=$2
  local file=$3
  LINE=$(grep -nF -- "$pat" "$file" 2>/dev/null | head -n 1 | cut -d: -f1 || true)
  [ -n "$LINE" ] || fail "$what: '$pat' is missing from ${file##*/}"
}

assert_no_line() {
  local what=$1
  local pat=$2
  local file=$3
  if [ -f "$file" ] && grep -qF -- "$pat" "$file"; then
    fail "$what: unexpected '$pat' in ${file##*/}"
  fi
}

assert_before() {
  local what=$1
  local first=$2
  local second=$3
  [ -n "$first" ] && [ -n "$second" ] || fail "$what: a required log line is missing"
  [ "$first" -lt "$second" ] || fail "$what: expected log line $first to precede line $second"
}

out_contains() {
  local what=$1
  local pat=$2
  grep -qF -- "$pat" "$OUT" || fail "$what: '$pat' is missing from release output"
}

count_backup_sets() {
  find "$CURVED_BACKUP_DIR/pre-deploy" -mindepth 1 -maxdepth 1 \
    -type d -name '20*' 2>/dev/null | wc -l || true
}

# --- Deploy ordering, image tag, latest tag order, probe, state -------------
new_logdir happy
STATE="$TMP_DIR/state/happy"
seed_state "$STATE"
unset SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true

run_release happy "${COMMON[@]}" --state-file "$STATE"
[ "$RC" -eq 0 ] || fail "happy-path release exited $RC: $(cat "$OUT")"
pass "release of the current HEAD succeeds"

D="$LOGDIR/docker.log"
C="$LOGDIR/curl.log"

require_line "database up" "up -d --wait --wait-timeout 300 db" "$D"
db_up=$LINE
require_line "build" " build app" "$D"
build=$LINE
require_line "migration run" "run --rm --no-deps -T app node src/composition/migrate.ts" "$D"
migration=$LINE
require_line "app up" "up -d --no-deps --wait --wait-timeout 600 app" "$D"
app_up=$LINE
require_line "caddy up" "up -d --no-deps caddy" "$D"
caddy_up=$LINE
require_line "pre-deploy backup dump" "pg_dump" "$D"
backup_dump=$LINE
require_line "pre-deploy backup caddy check" "ps -q caddy" "$D"
backup_caddy=$LINE
require_line "latest tag" "tag curved:$SHORT curved:latest" "$D"
latest=$LINE

assert_before "database precedes the build" "$db_up" "$build"
assert_before "database precedes the pre-deploy backup" "$db_up" "$backup_dump"
assert_before "the pre-deploy backup precedes the build" "$backup_dump" "$build"
assert_before "the pre-deploy backup precedes migrations" "$backup_dump" "$migration"
assert_before "the pre-deploy backup checks caddy before the build" "$backup_caddy" "$build"
assert_before "build precedes migrations" "$build" "$migration"
assert_before "migrations precede the app recreation" "$migration" "$app_up"
assert_before "the app is healthy before curved:latest moves" "$app_up" "$latest"
assert_before "caddy is reloaded before curved:latest moves" "$caddy_up" "$latest"
pass "deploy order is db < backup < build < migrate < app up < latest tag"

build_line=$(grep -F -- ' build app' "$D" | head -n 1)
case "$build_line" in
  *"CURVED_IMAGE=curved:$SHORT "*) ;;
  *) fail "the build does not target curved:$SHORT: $build_line" ;;
esac
[ "${#SHORT}" -eq 7 ] || fail "the fixture short sha is not seven characters"
pass "the build targets curved:$SHORT"

backup_link="$CURVED_BACKUP_DIR/pre-deploy/latest"
[ -L "$backup_link" ] || fail "the happy release published no pre-deploy latest symlink"
backup_set=$(readlink -f -- "$backup_link") || fail "the pre-deploy latest symlink does not resolve"
case "$backup_set" in
  "$CURVED_BACKUP_DIR/pre-deploy"/[0-9]*) ;;
  *) fail "the pre-deploy latest symlink does not point at a timestamped set: $backup_set" ;;
esac
for artifact in manifest.txt SHA256SUMS postgres.dump caddy-data.tar.gz caddy-config.tar.gz; do
  [ -s "$backup_set/$artifact" ] || fail "the published backup set is missing or has an empty $artifact"
done
grep -q '^backup_format=1$' "$backup_set/manifest.txt" || fail "the published backup manifest has no backup_format"
grep -q '^kind=pre-deploy$' "$backup_set/manifest.txt" || fail "the published backup manifest has the wrong kind"
grep -q '^tag=curved:'"$SHORT"'$' "$backup_set/manifest.txt" \
  || fail "the published backup manifest does not record curved:$SHORT"
grep -q '^caddy=archived$' "$backup_set/manifest.txt" \
  || fail "the published backup manifest did not archive Caddy"
if ! (cd "$backup_set" && sha256sum -c --status SHA256SUMS); then
  fail "the published backup set fails its checksum verification"
fi
pass "the happy release publishes a verifiable pre-deploy backup set for curved:$SHORT"

latest_line=$(grep -F -- 'tag curved:' "$D" | head -n 1)
case "$latest_line" in
  *"tag curved:$SHORT curved:latest") ;;
  *) fail "the latest tag line is unexpected: $latest_line" ;;
esac
tag_count=$(grep -cF -- 'tag curved:' "$D" || true)
[ "$tag_count" -eq 1 ] || fail "expected exactly one docker tag invocation, saw $tag_count"
pass "only curved:$SHORT is tagged curved:latest, after the app is healthy"

grep -q '^tag=curved:'"$SHORT"'$' "$STATE" || fail "state tag is not tag=curved:$SHORT"
grep -q '^sha='"$SHORT"'$' "$STATE" || fail "state sha is not sha=$SHORT"
grep -q '^at=.*Z$' "$STATE" || fail "state timestamp is not a UTC ISO-8601 value"
pass "state records the released tag, sha, and UTC timestamp"

require_line "probe header" "Authorization: Bearer $TOKEN" "$C"
require_line "probe path" "https://release.test/api/projects" "$C"
require_line "internal CA" "--cacert" "$C"
pass "the probe sends the bearer token to /api/projects with the internal CA"

# --- Migration failure isolation -------------------------------------------
new_logdir migfail
STATE="$TMP_DIR/state/migfail"
unset SMOKE_CURL_FAIL SMOKE_DOCKER_MISSING_IMAGE || true
export SMOKE_DOCKER_FAIL="migrate.ts"

run_release migfail "${COMMON[@]}" --state-file "$STATE"
unset SMOKE_DOCKER_FAIL
[ "$RC" -ne 0 ] || fail "a failed migration exited zero"
out_contains "migration failure" "previous app is still serving"
D="$LOGDIR/docker.log"
require_line "build ran" " build app" "$D"
assert_no_line "no app recreation" "up -d --no-deps" "$D"
assert_no_line "no latest tag" "tag curved:" "$D"
[ ! -e "$STATE" ] || fail "a failed migration wrote the state file"
pass "a failed migration exits nonzero before touching app, caddy, latest, or state"

# --- Pre-deploy backup failure is fatal before anything moves --------------
new_logdir backfail
STATE="$TMP_DIR/state/backfail"
seed_state "$STATE"
cp "$STATE" "$TMP_DIR/state/backfail.before"
unset SMOKE_CURL_FAIL SMOKE_DOCKER_MISSING_IMAGE || true
export SMOKE_DOCKER_FAIL="pg_dump"
sets_before=$(count_backup_sets)
latest_before=$(readlink -f -- "$CURVED_BACKUP_DIR/pre-deploy/latest" 2>/dev/null || true)

run_release backfail "${COMMON[@]}" --state-file "$STATE"
unset SMOKE_DOCKER_FAIL
[ "$RC" -ne 0 ] || fail "a failed pre-deploy backup exited zero"
out_contains "backup failure" \
  "the pre-deploy backup failed; no migration, container, image tag, or state change happened"
D="$LOGDIR/docker.log"
require_line "backup dump attempted" "pg_dump" "$D"
assert_no_line "no build after a failed backup" " build app" "$D"
assert_no_line "no migrations after a failed backup" "migrate.ts" "$D"
assert_no_line "no container recreation after a failed backup" "up -d --no-deps" "$D"
assert_no_line "no latest tag after a failed backup" "tag curved:" "$D"
cmp -s "$TMP_DIR/state/backfail.before" "$STATE" \
  || fail "a failed pre-deploy backup changed the state file"
sets_after=$(count_backup_sets)
[ "$sets_after" -eq "$sets_before" ] || fail "a failed pre-deploy backup published a set"
latest_after=$(readlink -f -- "$CURVED_BACKUP_DIR/pre-deploy/latest" 2>/dev/null || true)
[ "$latest_after" = "$latest_before" ] || fail "a failed pre-deploy backup moved latest"
staging_left=$(find "$CURVED_BACKUP_DIR" -name '.tmp.*' 2>/dev/null || true)
[ -z "$staging_left" ] || fail "a failed pre-deploy backup left staging dirs behind: $staging_left"
pass "a failed pre-deploy backup is fatal and leaves build, migrations, containers, latest, and state untouched"

# --- First release: absent state, failing probe, probe skipped --------------
new_logdir first
STATE="$TMP_DIR/state/first"
unset SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true
export SMOKE_CURL_FAIL=1

run_release first "${COMMON[@]}" --state-file "$STATE"
unset SMOKE_CURL_FAIL
[ "$RC" -eq 0 ] || fail "the first release with a failing probe exited $RC: $(cat "$OUT")"
out_contains "first-release skip" "first release"
grep -q '^tag=curved:'"$SHORT"'$' "$STATE" || fail "the first release did not write state"
[ ! -s "$LOGDIR/curl.log" ] || fail "the first release probed despite an absent state file"
pass "an absent state file skips the probe and still records the release"

# --- Later release: failing probe is red and changes nothing ---------------
new_logdir laterfail
cp "$STATE" "$TMP_DIR/state/first.before"
unset SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true
export SMOKE_CURL_FAIL=1

run_release laterfail "${COMMON[@]}" --state-file "$STATE"
unset SMOKE_CURL_FAIL
[ "$RC" -ne 0 ] || fail "a later release with a failing probe exited zero"
out_contains "probe failure" "public probe failed"
cmp -s "$TMP_DIR/state/first.before" "$STATE" || fail "a failed probe changed the state file"
D="$LOGDIR/docker.log"
C="$LOGDIR/curl.log"
require_line "probe attempted" "curl " "$C"
assert_no_line "no latest tag on probe failure" "tag curved:$SHORT curved:latest" "$D"
pass "a failed probe on a later release is fatal and leaves state and latest untouched"

# --- Later release: passing probe succeeds ---------------------------------
new_logdir laterok
unset SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true

run_release laterok "${COMMON[@]}" --state-file "$STATE"
[ "$RC" -eq 0 ] || fail "a later release with a passing probe exited $RC: $(cat "$OUT")"
D="$LOGDIR/docker.log"
require_line "latest tag" "tag curved:$SHORT curved:latest" "$D"
pass "a later release with a passing probe moves curved:latest"

# --- Explicit probe skip ---------------------------------------------------
new_logdir skip
export SMOKE_CURL_FAIL=1

run_release skip "${COMMON[@]}" --state-file "$STATE" --skip-public-probe
unset SMOKE_CURL_FAIL
[ "$RC" -eq 0 ] || fail "--skip-public-probe release exited $RC: $(cat "$OUT")"
out_contains "skip warning" "public probe skipped"
D="$LOGDIR/docker.log"
require_line "latest tag" "tag curved:$SHORT curved:latest" "$D"
[ ! -s "$LOGDIR/curl.log" ] || fail "--skip-public-probe still probed"
pass "--skip-public-probe lets a later release pass with a failing endpoint"

# --- Public TLS: the probe requires a matching HSTS header -----------------
PUBLIC_ENV="$TMP_DIR/public.env"
cat > "$PUBLIC_ENV" <<EOF
POSTGRES_USER=smoke
POSTGRES_PASSWORD=smoke
POSTGRES_DB=smoke
CURVED_UI_TOKEN=$TOKEN
GITHUB_WEBHOOK_SECRET=smoke-webhook-secret
CURVED_DOMAIN=public.test
ACME_EMAIL=ops@public.test
CURVED_HSTS_MAX_AGE=31536000
COOKIE_SECURE=1
EOF
chmod 600 "$PUBLIC_ENV"

PUBLIC_COMMON=(--env-file "$PUBLIC_ENV" --compose-file "$COMPOSE_FILE")

new_logdir public-ok
STATE="$TMP_DIR/state/public-ok"
seed_state "$STATE"
unset SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true
export SMOKE_CURL_HSTS="max-age=31536000"

run_release public-ok "${PUBLIC_COMMON[@]}" --state-file "$STATE"
unset SMOKE_CURL_HSTS
[ "$RC" -eq 0 ] || fail "a public release with a matching HSTS header exited $RC: $(cat "$OUT")"
D="$LOGDIR/docker.log"
C="$LOGDIR/curl.log"
require_line "public latest tag" "tag curved:$SHORT curved:latest" "$D"
require_line "public probe path" "https://public.test/api/projects" "$C"
assert_no_line "public probe keeps certificate verification on" " -k" "$C"
grep -q '^tag=curved:'"$SHORT"'$' "$STATE" || fail "the public release did not write state"
grep -q '^sha='"$SHORT"'$' "$STATE" || fail "the public release did not record the sha"
pass "a public release passes the probe with a matching HSTS max-age"

new_logdir public-nohsts
STATE="$TMP_DIR/state/public-nohsts"
seed_state "$STATE"
cp "$STATE" "$TMP_DIR/state/public-nohsts.before"
unset SMOKE_CURL_HSTS SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true

run_release public-nohsts "${PUBLIC_COMMON[@]}" --state-file "$STATE"
[ "$RC" -ne 0 ] || fail "a public release without an HSTS header exited zero"
out_contains "missing HSTS" "no Strict-Transport-Security header"
cmp -s "$TMP_DIR/state/public-nohsts.before" "$STATE" || fail "a release without HSTS changed the state file"
assert_no_line "no latest tag without HSTS" "tag curved:$SHORT curved:latest" "$LOGDIR/docker.log"
pass "a public release without HSTS is fatal and leaves latest and state untouched"

new_logdir public-hsts-mismatch
STATE="$TMP_DIR/state/public-hsts-mismatch"
seed_state "$STATE"
cp "$STATE" "$TMP_DIR/state/public-hsts-mismatch.before"
unset SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true
export SMOKE_CURL_HSTS="max-age=600"

run_release public-hsts-mismatch "${PUBLIC_COMMON[@]}" --state-file "$STATE"
unset SMOKE_CURL_HSTS
[ "$RC" -ne 0 ] || fail "a public release with a mismatched HSTS max-age exited zero"
out_contains "HSTS max-age mismatch" \
  "Strict-Transport-Security max-age is '600' but CURVED_HSTS_MAX_AGE is '31536000'"
cmp -s "$TMP_DIR/state/public-hsts-mismatch.before" "$STATE" \
  || fail "a release with a mismatched HSTS max-age changed the state file"
assert_no_line "no latest tag on HSTS mismatch" "tag curved:$SHORT curved:latest" "$LOGDIR/docker.log"
pass "a public release with a mismatched HSTS max-age is fatal and leaves latest and state untouched"

new_logdir internal-nohsts
STATE="$TMP_DIR/state/internal-nohsts"
seed_state "$STATE"
unset SMOKE_CURL_HSTS SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true

run_release internal-nohsts "${COMMON[@]}" --state-file "$STATE"
[ "$RC" -eq 0 ] || fail "an internal release without an HSTS header exited $RC: $(cat "$OUT")"
D="$LOGDIR/docker.log"
C="$LOGDIR/curl.log"
require_line "internal latest tag" "tag curved:$SHORT curved:latest" "$D"
require_line "internal CA" "--cacert" "$C"
grep -q '^tag=curved:'"$SHORT"'$' "$STATE" || fail "the internal release did not write state"
pass "an internal release passes the probe without an HSTS header"

# --- Rollback --------------------------------------------------------------
new_logdir rollback
STATE="$TMP_DIR/state/rollback"
seed_state "$STATE"
unset SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL SMOKE_DOCKER_MISSING_IMAGE || true

run_release rollback rollback "$ROLLBACK_SHA" "${COMMON[@]}" --state-file "$STATE"
[ "$RC" -eq 0 ] || fail "rollback exited $RC: $(cat "$OUT")"
D="$LOGDIR/docker.log"
C="$LOGDIR/curl.log"
require_line "image inspect" "image inspect curved:$ROLLBACK_SHA" "$D"
inspect_line=$LINE
require_line "rollback image" "CURVED_IMAGE=curved:$ROLLBACK_SHA compose" "$D"
rollback_image_line=$LINE
require_line "rollback app up" "up -d --no-deps --wait app" "$D"
rollback_app=$LINE
require_line "rollback caddy up" "up -d --no-deps caddy" "$D"
rollback_caddy=$LINE
assert_before "the image exists before it is deployed" "$inspect_line" "$rollback_app"
assert_before "the app comes up before caddy is reloaded" "$rollback_app" "$rollback_caddy"
assert_no_line "rollback runs no migrations" "migrate.ts" "$D"
assert_no_line "rollback takes no pre-deploy backup" "pg_dump" "$D"
assert_no_line "rollback does not move latest" "tag curved:" "$D"
require_line "rollback probe header" "Authorization: Bearer $TOKEN" "$C"
grep -q '^tag=curved:'"$ROLLBACK_SHA"'$' "$STATE" || fail "rollback state tag is wrong"
grep -q '^sha='"$ROLLBACK_SHA"'$' "$STATE" || fail "rollback state sha is wrong"
out_contains "rollback warning" "restore the database"
pass "rollback deploys the image, skips migrations and the backup, probes, and records the state"

# --- Rollback of a missing image ------------------------------------------
new_logdir rollback-missing
STATE="$TMP_DIR/state/rollback-missing"
seed_state "$STATE"
unset SMOKE_CURL_FAIL SMOKE_DOCKER_FAIL || true
export SMOKE_DOCKER_MISSING_IMAGE="curved:deadbee"

run_release rollback-missing rollback deadbee "${COMMON[@]}" --state-file "$STATE"
unset SMOKE_DOCKER_MISSING_IMAGE
[ "$RC" -ne 0 ] || fail "rollback of a missing image exited zero"
assert_no_line "no deploy of a missing image" "up -d --no-deps" "$LOGDIR/docker.log"
pass "rollback refuses an image that is not on the host"

# --- Static and secrecy checks --------------------------------------------
if grep -qF -- 'down -v' "$RELEASE"; then
  fail "deploy/release.sh contains a stack-teardown command"
fi
pass "deploy/release.sh contains no teardown command"

if grep -rqF -- "$TOKEN" "$TMP_DIR/out"; then
  fail "the UI token appeared on release stdout or stderr"
fi
pass "the UI token never appears in release output"

printf 'release-smoke: all checks passed\n'
