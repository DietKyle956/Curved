#!/usr/bin/env bash
# Backup gate: exercise deploy/backup.sh and deploy/restore.sh end to end
# against stub binaries in a throwaway PATH, so no Docker daemon, database, or
# real volume is touched. Covers the nightly layout, the frozen manifest keys,
# SHA256SUMS, the relative latest symlink, the 0700/0600 modes, retention with
# --keep and --no-prune, a failed and an empty dump leaving earlier sets and
# latest untouched, the pre-deploy caddy skip, the nightly caddy requirement,
# the --yes refusal, checksum tampering, a drill restore into a separate
# database, a production-database restore that leaves the app stopped, and a
# Caddy volume restore.
#
# Stub knobs, set in the environment of a scenario:
#   SMOKE_CADDY_DOWN=1         docker compose ps -q caddy prints nothing
#   SMOKE_DOCKER_FAIL=SUBSTR   docker exits 1 when its joined args contain SUBSTR
#   SMOKE_PGDUMP_EMPTY=1       pg_dump succeeds but writes nothing
#
# Each scenario's stub invocations are logged under <tmp>/logs/<scenario>/
# (docker.log, order.log, extract.log, pg_restore.stdin); backup and restore
# stdout and stderr go to <tmp>/out/<scenario>.log. PASS lines name each
# assertion; the first failed assertion prints FAIL and exits 1.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="$ROOT_DIR/deploy/backup.sh"
RESTORE="$ROOT_DIR/deploy/restore.sh"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.yml"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/curved-backup-smoke.XXXXXX")
cleanup() {
  local status=$?
  rm -rf -- "$TMP_DIR"
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'backup-smoke: FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS %s\n' "$1"
}

[ -f "$BACKUP" ] || fail "deploy/backup.sh is missing"
[ -x "$BACKUP" ] || fail "deploy/backup.sh is not executable"
bash -n "$BACKUP" || fail "deploy/backup.sh does not parse (bash -n)"
[ -f "$RESTORE" ] || fail "deploy/restore.sh is missing"
[ -x "$RESTORE" ] || fail "deploy/restore.sh is not executable"
bash -n "$RESTORE" || fail "deploy/restore.sh does not parse (bash -n)"
pass "deploy/backup.sh and deploy/restore.sh are executable and parse"

STUB_DIR="$TMP_DIR/bin"
FIXTURES="$TMP_DIR/fixtures"
mkdir -p "$STUB_DIR" "$TMP_DIR/out" "$FIXTURES/caddy-data" "$FIXTURES/caddy-config"
printf 'smoke caddy data volume\n' > "$FIXTURES/caddy-data/site.crt"
printf 'smoke caddy config volume\n' > "$FIXTURES/caddy-config/Caddyfile"

cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
# Fake docker: logs every invocation and answers the compose calls that
# deploy/backup.sh and deploy/restore.sh make. pg_dump writes a canned custom
# format payload, the caddy archives are real tar.gz streams built from fixture
# directories (so tar -tzf accepts them), and restore-side extraction consumes
# stdin so the caller never sees SIGPIPE.
set -uo pipefail
line="$*"
printf 'docker %s\n' "$line" >> "$STUB_LOG/docker.log"
printf 'docker %s\n' "$line" >> "$STUB_LOG/order.log"

if [ -n "${SMOKE_DOCKER_FAIL:-}" ] && [[ "$line" == *"$SMOKE_DOCKER_FAIL"* ]]; then
  printf 'docker: simulated failure (%s)\n' "$SMOKE_DOCKER_FAIL" >&2
  exit 1
fi

case " $line " in
  *" compose version "* | *" --version "*)
    printf 'Docker Compose version v2.29.0\n'
    exit 0
    ;;
  *" ps -q caddy "*)
    if [ -z "${SMOKE_CADDY_DOWN:-}" ]; then
      printf 'caddy000000000000\n'
    fi
    exit 0
    ;;
  *" exec -T db pg_dump "*)
    [ -n "${SMOKE_PGDUMP_EMPTY:-}" ] && exit 0
    printf 'PGDMP smoke custom-format dump\n'
    printf 'payload %s\n' "${STUB_DUMP_LABEL:-nightly}"
    exit 0
    ;;
  *" exec -T db pg_restore "*)
    cat > "$STUB_LOG/pg_restore.stdin"
    exit 0
    ;;
  *" exec -T db psql "*)
    case "$line" in
      *"datname='smoke'"*) printf '1\n' ;;
    esac
    exit 0
    ;;
  *" exec -T caddy tar -C /data -czf - ."*)
    tar -C "$STUB_CADDY_DATA" -czf - .
    exit 0
    ;;
  *" exec -T caddy tar -C /config -czf - ."*)
    tar -C "$STUB_CADDY_CONFIG" -czf - .
    exit 0
    ;;
  *" run --rm "*"tar -C /data -xzf -"*)
    bytes=$(cat | wc -c | tr -d '[:space:]')
    printf 'extract data bytes=%s\n' "$bytes" >> "$STUB_LOG/extract.log"
    exit 0
    ;;
  *" run --rm "*"tar -C /config -xzf -"*)
    bytes=$(cat | wc -c | tr -d '[:space:]')
    printf 'extract config bytes=%s\n' "$bytes" >> "$STUB_LOG/extract.log"
    exit 0
    ;;
esac
exit 0
STUB

chmod +x "$STUB_DIR/docker"

export PATH="$STUB_DIR:$PATH"
export STUB_CADDY_DATA="$FIXTURES/caddy-data"
export STUB_CADDY_CONFIG="$FIXTURES/caddy-config"

ENV_FILE="$TMP_DIR/backup.env"
cat > "$ENV_FILE" <<EOF
POSTGRES_USER=smoke
POSTGRES_PASSWORD=smoke
POSTGRES_DB=smoke
CURVED_DOMAIN=backup.test
EOF
chmod 600 "$ENV_FILE"

COMMON=(--env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE")

new_logdir() {
  LOGDIR="$TMP_DIR/logs/$1"
  rm -rf -- "$LOGDIR"
  mkdir -p "$LOGDIR"
  export STUB_LOG="$LOGDIR"
}

OUT=""
RC=0
run() {
  local name=$1
  shift
  OUT="$TMP_DIR/out/$name.log"
  RC=0
  "$@" > "$OUT" 2>&1 || RC=$?
}

out_contains() {
  local what=$1
  local pat=$2
  grep -qF -- "$pat" "$OUT" || fail "$what: '$pat' is missing from ${OUT##*/}"
}

out_matches() {
  local what=$1
  local pat=$2
  grep -qE -- "$pat" "$OUT" || fail "$what: no line in ${OUT##*/} matches /$pat/"
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

mode_of() {
  stat -c '%a' -- "$1"
}

list_sets() {
  find "$1" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort
}

newest_set() {
  local newest
  newest=$(list_sets "$1" | tail -n 1)
  if [ -n "$newest" ]; then
    printf '%s/%s\n' "$1" "$newest"
  fi
}

count_sets() {
  list_sets "$1" | wc -l | tr -d '[:space:]'
}

manifest_value() {
  grep -m 1 "^$2=" "$1" | cut -d= -f2- || true
}

seed_set() {
  local kind_dir=$1
  local name=$2
  local stamp=$3
  install -d -m 0700 -- "$kind_dir/$name"
  touch -t "$stamp" -- "$kind_dir/$name"
}

for seed_knob in SMOKE_CADDY_DOWN SMOKE_DOCKER_FAIL SMOKE_PGDUMP_EMPTY; do
  unset "$seed_knob" || true
done

# --- Nightly happy path: layout, manifest, checksums, latest, modes --------
BASE="$TMP_DIR/base/nightly"
new_logdir nightly
run nightly "$BACKUP" nightly --output-dir "$BASE" "${COMMON[@]}"
[ "$RC" -eq 0 ] || fail "nightly backup exited $RC: $(tr '\n' '|' < "$OUT")"
SET_NIGHTLY=$(newest_set "$BASE/nightly")
[ -n "$SET_NIGHTLY" ] || fail "the nightly backup published no set under $BASE/nightly"
[ -d "$SET_NIGHTLY" ] || fail "the published nightly set is not a directory"

[ "$(mode_of "$BASE")" = "700" ] || fail "the backup base is not mode 0700 (got $(mode_of "$BASE"))"
[ "$(mode_of "$SET_NIGHTLY")" = "700" ] || fail "the nightly set is not mode 0700 (got $(mode_of "$SET_NIGHTLY"))"
pass "the backup base and the nightly set are mode 0700"

for artifact in manifest.txt SHA256SUMS postgres.dump caddy-data.tar.gz caddy-config.tar.gz; do
  [ -f "$SET_NIGHTLY/$artifact" ] || fail "the nightly set is missing $artifact"
  [ "$(mode_of "$SET_NIGHTLY/$artifact")" = "600" ] \
    || fail "$artifact is not mode 0600 (got $(mode_of "$SET_NIGHTLY/$artifact"))"
done
[ -s "$SET_NIGHTLY/postgres.dump" ] || fail "postgres.dump is empty"
[ -s "$SET_NIGHTLY/caddy-data.tar.gz" ] || fail "caddy-data.tar.gz is empty"
[ -s "$SET_NIGHTLY/caddy-config.tar.gz" ] || fail "caddy-config.tar.gz is empty"
tar -tzf "$SET_NIGHTLY/caddy-data.tar.gz" >/dev/null \
  || fail "caddy-data.tar.gz is not a readable tar archive"
tar -tzf "$SET_NIGHTLY/caddy-config.tar.gz" >/dev/null \
  || fail "caddy-config.tar.gz is not a readable tar archive"
pass "the nightly set holds the dump, both caddy archives, the manifest, and the checksums at 0600"

EXPECTED_KEYS=$'backup_format\nkind\ncreated_at\ngit_sha\nhostname\npostgres_user\npostgres_db\ncaddy\ntag\nlabel'
ACTUAL_KEYS=$(cut -d= -f1 "$SET_NIGHTLY/manifest.txt")
[ "$ACTUAL_KEYS" = "$EXPECTED_KEYS" ] \
  || fail "manifest.txt keys are not the frozen ten in order: $(tr '\n' ' ' <<<"$ACTUAL_KEYS")"
[ "$(manifest_value "$SET_NIGHTLY/manifest.txt" backup_format)" = "1" ] \
  || fail "manifest.txt does not record backup_format=1"
[ "$(manifest_value "$SET_NIGHTLY/manifest.txt" kind)" = "nightly" ] \
  || fail "manifest.txt does not record kind=nightly"
grep -qE '^created_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' "$SET_NIGHTLY/manifest.txt" \
  || fail "manifest.txt created_at is not a UTC ISO-8601 timestamp"
grep -qE '^git_sha=([0-9a-f]{7,40}|unknown)$' "$SET_NIGHTLY/manifest.txt" \
  || fail "manifest.txt git_sha is neither a short sha nor unknown"
grep -qE '^hostname=.+$' "$SET_NIGHTLY/manifest.txt" \
  || fail "manifest.txt hostname is empty"
[ "$(manifest_value "$SET_NIGHTLY/manifest.txt" postgres_user)" = "smoke" ] \
  || fail "manifest.txt postgres_user is not smoke"
[ "$(manifest_value "$SET_NIGHTLY/manifest.txt" postgres_db)" = "smoke" ] \
  || fail "manifest.txt postgres_db is not smoke"
grep -qx 'caddy=archived' "$SET_NIGHTLY/manifest.txt" \
  || fail "manifest.txt does not record caddy=archived"
grep -qx 'tag=' "$SET_NIGHTLY/manifest.txt" \
  || fail "manifest.txt tag is not empty for a nightly backup"
grep -qx 'label=' "$SET_NIGHTLY/manifest.txt" \
  || fail "manifest.txt label is not empty for a nightly backup"
pass "manifest.txt records the frozen keys and values in order"

SUMS=$(awk '{print $2}' "$SET_NIGHTLY/SHA256SUMS" | sed 's|^\./||' | sort | tr '\n' ' ')
[ "$SUMS" = "caddy-config.tar.gz caddy-data.tar.gz postgres.dump " ] \
  || fail "SHA256SUMS covers '$SUMS' instead of the three artifacts"
(cd -- "$SET_NIGHTLY" && sha256sum -c --status SHA256SUMS) \
  || fail "SHA256SUMS does not verify inside the nightly set"
pass "SHA256SUMS covers every stored artifact and verifies"

[ -L "$BASE/nightly/latest" ] || fail "$BASE/nightly/latest is not a symlink"
[ "$(readlink -- "$BASE/nightly/latest")" = "$(basename -- "$SET_NIGHTLY")" ] \
  || fail "latest does not point at the newest set name"
[ -d "$BASE/nightly/latest" ] || fail "latest does not resolve to a directory"
pass "latest is a relative symlink to the newest nightly set"

[ "$(tail -n 1 "$OUT")" = "backup: ok $SET_NIGHTLY" ] \
  || fail "the last output line is not 'backup: ok $SET_NIGHTLY' (got '$(tail -n 1 "$OUT")')"
D="$LOGDIR/docker.log"
require_line "dump invocation" "pg_dump -U smoke -d smoke -Fc -Z 9 --no-owner --no-privileges" "$D"
require_line "caddy data archive" "exec -T caddy tar -C /data -czf - ." "$D"
require_line "caddy config archive" "exec -T caddy tar -C /config -czf - ." "$D"
pass "the nightly dump and both caddy archives run with the documented flags"

# --- Retention: --keep prunes the oldest, --no-prune keeps everything ------
BASE="$TMP_DIR/base/retention"
install -d -m 0700 -- "$BASE/nightly"
for day in 01 02 03 04; do
  seed_set "$BASE/nightly" "202001${day}T000000Z" "202001${day}0000"
done
new_logdir retention
run retention "$BACKUP" nightly --output-dir "$BASE" --keep 2 "${COMMON[@]}"
[ "$RC" -eq 0 ] || fail "nightly --keep 2 exited $RC: $(tr '\n' '|' < "$OUT")"
RETENTION_NEW=$(newest_set "$BASE/nightly")
[ "$(count_sets "$BASE/nightly")" = "2" ] \
  || fail "--keep 2 retained $(count_sets "$BASE/nightly") sets: $(list_sets "$BASE/nightly" | tr '\n' ' ')"
[ ! -e "$BASE/nightly/20200101T000000Z" ] || fail "--keep 2 did not prune the oldest set (20200101)"
[ ! -e "$BASE/nightly/20200102T000000Z" ] || fail "--keep 2 retained a set older than the two newest"
[ ! -e "$BASE/nightly/20200103T000000Z" ] || fail "--keep 2 retained a set older than the two newest"
[ -d "$BASE/nightly/20200104T000000Z" ] || fail "--keep 2 pruned a set it should have kept (20200104)"
[ -d "$RETENTION_NEW" ] || fail "the newest set was pruned"
[ "$(readlink -- "$BASE/nightly/latest")" = "$(basename -- "$RETENTION_NEW")" ] \
  || fail "--keep 2 moved latest away from the newest set"
pass "--keep prunes the oldest sets and keeps exactly the newest ones"

BASE="$TMP_DIR/base/noprune"
install -d -m 0700 -- "$BASE/nightly"
for day in 01 02 03 04; do
  seed_set "$BASE/nightly" "202001${day}T000000Z" "202001${day}0000"
done
new_logdir noprune
run noprune env CURVED_BACKUP_DIR="$BASE" "$BACKUP" nightly --keep 1 --no-prune "${COMMON[@]}"
[ "$RC" -eq 0 ] || fail "nightly --no-prune exited $RC: $(tr '\n' '|' < "$OUT")"
[ "$(count_sets "$BASE/nightly")" = "5" ] \
  || fail "--no-prune kept $(count_sets "$BASE/nightly") sets instead of all five"
for day in 01 02 03 04; do
  [ -d "$BASE/nightly/202001${day}T000000Z" ] || fail "--no-prune removed the 202001$day set"
done
[ "$(readlink -- "$BASE/nightly/latest")" = "$(basename -- "$(newest_set "$BASE/nightly")")" ] \
  || fail "--no-prune did not publish latest"
pass "--no-prune keeps every set and honors CURVED_BACKUP_DIR"

# --- A failed or empty dump leaves earlier sets and latest untouched -------
BASE="$TMP_DIR/base/failure"
new_logdir failure-seed
run failure-seed "$BACKUP" nightly --output-dir "$BASE" "${COMMON[@]}"
[ "$RC" -eq 0 ] || fail "the seed nightly backup exited $RC: $(tr '\n' '|' < "$OUT")"
FAILURE_SET=$(newest_set "$BASE/nightly")
FAILURE_DIRS=$(list_sets "$BASE/nightly")
FAILURE_LATEST=$(readlink -- "$BASE/nightly/latest")
FAILURE_SUM=$(sha256sum "$FAILURE_SET/manifest.txt" | cut -d' ' -f1)

new_logdir failure-dump
export SMOKE_DOCKER_FAIL=pg_dump
run failure-dump "$BACKUP" nightly --output-dir "$BASE" "${COMMON[@]}"
unset SMOKE_DOCKER_FAIL
[ "$RC" -ne 0 ] || fail "a failing pg_dump exited zero"
out_contains "dump failure" "pg_dump failed"
[ "$(list_sets "$BASE/nightly")" = "$FAILURE_DIRS" ] \
  || fail "a failing pg_dump added or removed a set: $(list_sets "$BASE/nightly" | tr '\n' ' ')"
[ "$(readlink -- "$BASE/nightly/latest")" = "$FAILURE_LATEST" ] \
  || fail "a failing pg_dump moved latest"
[ "$(sha256sum "$FAILURE_SET/manifest.txt" | cut -d' ' -f1)" = "$FAILURE_SUM" ] \
  || fail "a failing pg_dump rewrote the previous manifest"
[ -z "$(find "$BASE/nightly" -mindepth 1 -maxdepth 1 -name '.tmp.*' -print -quit)" ] \
  || fail "a failing pg_dump left a staging directory behind"
pass "a failed dump exits nonzero and leaves earlier sets, latest, and staging untouched"

new_logdir failure-empty
export SMOKE_PGDUMP_EMPTY=1
run failure-empty "$BACKUP" nightly --output-dir "$BASE" "${COMMON[@]}"
unset SMOKE_PGDUMP_EMPTY
[ "$RC" -ne 0 ] || fail "an empty pg_dump exit zero"
out_contains "empty dump" "pg_dump produced an empty dump"
[ "$(list_sets "$BASE/nightly")" = "$FAILURE_DIRS" ] \
  || fail "an empty dump added or removed a set"
[ "$(readlink -- "$BASE/nightly/latest")" = "$FAILURE_LATEST" ] \
  || fail "an empty dump moved latest"
[ -z "$(find "$BASE/nightly" -mindepth 1 -maxdepth 1 -name '.tmp.*' -print -quit)" ] \
  || fail "an empty dump left a staging directory behind"
pass "an empty dump exits nonzero and publishes nothing"

# --- Pre-deploy with caddy absent: skipped caddy, tag recorded ------------
BASE="$TMP_DIR/base/predeploy"
new_logdir predeploy
export SMOKE_CADDY_DOWN=1
run predeploy "$BACKUP" pre-deploy --output-dir "$BASE" --tag v2.0.0 --label pre-deploy-smoke "${COMMON[@]}"
unset SMOKE_CADDY_DOWN
[ "$RC" -eq 0 ] || fail "pre-deploy without caddy exited $RC: $(tr '\n' '|' < "$OUT")"
SET_PREDEPLOY=$(newest_set "$BASE/pre-deploy")
[ -n "$SET_PREDEPLOY" ] || fail "pre-deploy published no set"
out_contains "caddy skip warning" "skipping the Caddy volumes"
grep -qx 'kind=pre-deploy' "$SET_PREDEPLOY/manifest.txt" \
  || fail "manifest.txt does not record kind=pre-deploy"
grep -qx 'caddy=skipped' "$SET_PREDEPLOY/manifest.txt" \
  || fail "manifest.txt does not record caddy=skipped"
grep -qx 'tag=v2.0.0' "$SET_PREDEPLOY/manifest.txt" \
  || fail "manifest.txt does not record tag=v2.0.0"
grep -qx 'label=pre-deploy-smoke' "$SET_PREDEPLOY/manifest.txt" \
  || fail "manifest.txt does not record label=pre-deploy-smoke"
[ ! -e "$SET_PREDEPLOY/caddy-data.tar.gz" ] || fail "pre-deploy stored caddy-data.tar.gz without caddy"
[ ! -e "$SET_PREDEPLOY/caddy-config.tar.gz" ] || fail "pre-deploy stored caddy-config.tar.gz without caddy"
[ "$(awk '{print $2}' "$SET_PREDEPLOY/SHA256SUMS" | tr '\n' ' ')" = "postgres.dump " ] \
  || fail "the pre-deploy SHA256SUMS is not just postgres.dump"
(cd -- "$SET_PREDEPLOY" && sha256sum -c --status SHA256SUMS) \
  || fail "the pre-deploy SHA256SUMS does not verify"
[ "$(readlink -- "$BASE/pre-deploy/latest")" = "$(basename -- "$SET_PREDEPLOY")" ] \
  || fail "pre-deploy latest does not point at the new set"
pass "pre-deploy without caddy records caddy=skipped, the tag, and the label"

BASE="$TMP_DIR/base/nightly-absent"
new_logdir nightly-absent
export SMOKE_CADDY_DOWN=1
run nightly-absent "$BACKUP" nightly --output-dir "$BASE" "${COMMON[@]}"
unset SMOKE_CADDY_DOWN
[ "$RC" -ne 0 ] || fail "a nightly backup without caddy exited zero"
out_contains "nightly caddy requirement" "the caddy container is not running"
[ -z "$(list_sets "$BASE/nightly" 2>/dev/null || true)" ] \
  || fail "a nightly backup without caddy published a set"
[ ! -e "$BASE/nightly/latest" ] || fail "a nightly backup without caddy published latest"
pass "a nightly backup without caddy is fatal and publishes nothing"

# --- Restore refuses without --yes, before any docker call ---------------
new_logdir refuse-postgres
run refuse-postgres "$RESTORE" postgres "$SET_NIGHTLY" "${COMMON[@]}"
[ "$RC" -eq 2 ] || fail "restore postgres without --yes exited $RC instead of 2"
out_contains "restore refusal" "restore: refusing to restore without --yes"
[ ! -s "$LOGDIR/docker.log" ] || fail "restore postgres refused but still called docker"

new_logdir refuse-caddy
run refuse-caddy "$RESTORE" caddy "$SET_NIGHTLY" "${COMMON[@]}"
[ "$RC" -eq 2 ] || fail "restore caddy without --yes exited $RC instead of 2"
out_contains "caddy restore refusal" "restore: refusing to restore without --yes"
[ ! -s "$LOGDIR/docker.log" ] || fail "restore caddy refused but still called docker"
pass "both restore modes refuse without --yes before any docker call"

# --- A tampered set fails before any restore step ------------------------
TAMPERED="$TMP_DIR/tampered-set"
cp -a -- "$SET_NIGHTLY" "$TAMPERED"
printf 'tampered\n' >> "$TAMPERED/postgres.dump"
new_logdir tamper
run tamper "$RESTORE" postgres "$TAMPERED" --yes "${COMMON[@]}"
[ "$RC" -ne 0 ] || fail "a restore of a tampered set exited zero"
out_contains "checksum tamper" "checksum verification failed"
[ ! -s "$LOGDIR/docker.log" ] || fail "a restore of a tampered set still called docker"
pass "a checksum mismatch fails before any docker call"

# --- Drill restore: separate database, app untouched ----------------------
new_logdir drill
run drill "$RESTORE" postgres "$SET_NIGHTLY" --database curved_drill --yes "${COMMON[@]}"
[ "$RC" -eq 0 ] || fail "the drill restore exited $RC: $(tr '\n' '|' < "$OUT")"
D="$LOGDIR/docker.log"
assert_no_line "drill leaves the app alone" "stop app" "$D"
require_line "database probe" "psql -U smoke -d postgres" "$D"
require_line "database creation" 'CREATE DATABASE "curved_drill"' "$D"
create_line=$LINE
require_line "drill pg_restore" \
  "pg_restore -U smoke -d curved_drill --clean --if-exists --no-owner --no-privileges" "$D"
drill_restore=$LINE
assert_before "the drill database exists before pg_restore" "$create_line" "$drill_restore"
[ -s "$LOGDIR/pg_restore.stdin" ] || fail "the drill restore piped no dump into pg_restore"
cmp -s "$LOGDIR/pg_restore.stdin" "$SET_NIGHTLY/postgres.dump" \
  || fail "the drill restore piped bytes other than postgres.dump"
out_matches "drill ok line" '^restore: ok postgres curved_drill in [0-9]+s$'
out_contains "drill drop hint" "dropdb"
pass "a drill restore creates the database, runs pg_restore with the documented flags, and never stops the app"

# --- Production-database restore stops the app and leaves it stopped ------
new_logdir default-restore
run default-restore "$RESTORE" postgres "$SET_PREDEPLOY" --yes "${COMMON[@]}"
[ "$RC" -eq 0 ] || fail "the default-database restore exited $RC: $(tr '\n' '|' < "$OUT")"
D="$LOGDIR/docker.log"
require_line "app stop" "stop app" "$D"
stop_line=$LINE
require_line "production pg_restore" \
  "pg_restore -U smoke -d smoke --clean --if-exists --no-owner --no-privileges" "$D"
default_restore=$LINE
assert_before "the app stops before pg_restore" "$stop_line" "$default_restore"
assert_no_line "the app is not restarted" " up -d" "$D"
assert_no_line "an existing database is not recreated" "CREATE DATABASE" "$D"
[ -s "$LOGDIR/pg_restore.stdin" ] || fail "the production restore piped no dump into pg_restore"
cmp -s "$LOGDIR/pg_restore.stdin" "$SET_PREDEPLOY/postgres.dump" \
  || fail "the production restore piped bytes other than postgres.dump"
out_contains "app stays stopped" "the app stayed stopped"
out_contains "rollback hint" "./deploy/release.sh rollback v2.0.0"
out_matches "production ok line" '^restore: ok postgres smoke in [0-9]+s$'
pass "a production-database restore stops the app before pg_restore and leaves it stopped"

# --- Caddy restore: stop, extract both archives, start --------------------
new_logdir caddy-restore
run caddy-restore "$RESTORE" caddy "$SET_NIGHTLY" --yes "${COMMON[@]}"
[ "$RC" -eq 0 ] || fail "the caddy restore exited $RC: $(tr '\n' '|' < "$OUT")"
D="$LOGDIR/docker.log"
require_line "caddy stop" "stop caddy" "$D"
caddy_stop=$LINE
require_line "data extraction" "tar -C /data -xzf -" "$D"
data_extract=$LINE
require_line "config extraction" "tar -C /config -xzf -" "$D"
config_extract=$LINE
require_line "caddy start" "up -d --no-deps --wait --wait-timeout 120 caddy" "$D"
caddy_start=$LINE
assert_before "caddy stops before the data extraction" "$caddy_stop" "$data_extract"
assert_before "the data extraction precedes the config extraction" "$data_extract" "$config_extract"
assert_before "caddy starts after both extractions" "$config_extract" "$caddy_start"
extract_count=$(grep -cF -- "run --rm" "$D" || true)
[ "$extract_count" -eq 2 ] || fail "the caddy restore ran $extract_count extraction containers instead of 2"
grep -qE '^extract data bytes=[1-9][0-9]*$' "$LOGDIR/extract.log" \
  || fail "the caddy data archive reached the extraction container empty"
grep -qE '^extract config bytes=[1-9][0-9]*$' "$LOGDIR/extract.log" \
  || fail "the caddy config archive reached the extraction container empty"
assert_no_line "caddy restore leaves postgres alone" "pg_restore" "$D"
out_matches "caddy ok line" '^restore: ok caddy$'
pass "a caddy restore stops caddy, extracts both archives, and starts caddy"

new_logdir caddy-noarchive
run caddy-noarchive "$RESTORE" caddy "$SET_PREDEPLOY" --yes "${COMMON[@]}"
[ "$RC" -ne 0 ] || fail "a caddy restore of a pre-deploy set exited zero"
out_contains "missing caddy archive" "does not record caddy=archived"
[ ! -s "$LOGDIR/docker.log" ] || fail "a caddy restore without archives still called docker"
pass "a caddy restore without archives fails before any docker call"

printf 'backup-smoke: all checks passed\n'
