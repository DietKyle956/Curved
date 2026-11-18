#!/usr/bin/env bash
# Provisioning gate: run deploy/bootstrap-host.sh and deploy/verify-host.sh in a
# throwaway ubuntu:24.04 container, with PATH stubs standing in for the host
# tools they call. Asserts the bootstrap contract, an idempotent re-run, the
# verifier's happy path, and two security boundaries (public 5432, password
# authentication). The container and the temp harness are always removed; the
# harness is kept with `--keep`.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE="ubuntu:24.04"
CONTAINER_NAME="curved-provision-smoke-$$"
HARNESS_DIR=""
keep=0

usage() {
  cat <<'EOF'
Usage: bash scripts/provision-smoke.sh [--keep]

Runs deploy/bootstrap-host.sh and deploy/verify-host.sh inside a throwaway
ubuntu:24.04 container. The host tools those scripts call (apt, docker, sshd,
lsblk, findmnt, blkid, blockdev, mount, mkfs.ext4, ss, curl, git, openssl,
systemctl, df) are replaced by stubs that model a 50 GiB root disk with a
100 GiB data volume. The checks are: fresh bootstrap, deploy user and key-only
SSH, sshd policy, one ext4 fstab entry, checkout, generated environment with no
secret on stdout, one compose up, an idempotent re-run, the verifier's happy
path, a public 5432 listener rejected, password authentication rejected, and a
--no-stack re-run that starts nothing.

  --keep     Keep the temp harness directory (stubs plus scenario).
  -h, --help Show this message.

The host itself is not modified; one disposable container is the only Docker
state touched.
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
      printf 'provision-smoke: unknown argument %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

fail() {
  printf 'provision-smoke: FAIL %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [ "$keep" -eq 0 ] && [ -n "$HARNESS_DIR" ] && [ -d "$HARNESS_DIR" ]; then
    rm -rf -- "$HARNESS_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is required"
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf 'provision-smoke: pulling %s\n' "$IMAGE"
  docker pull "$IMAGE" >/dev/null || fail "docker pull $IMAGE failed"
fi

for script in deploy/bootstrap-host.sh deploy/verify-host.sh; do
  bash -n "$script" || fail "$script does not parse"
done
printf 'PASS deploy scripts parse (bash -n)\n'

HARNESS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/curved-provision-smoke.XXXXXX")"
mkdir -p "$HARNESS_DIR/bin"

cat > "$HARNESS_DIR/bin/apt-get" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = install ]; then
  shift
  for pkg in "$@"; do
    if [ "$pkg" = docker.io ]; then
      groupadd -f docker
    fi
  done
fi
exit 0
STUB

cat > "$HARNESS_DIR/bin/apt-cache" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
exit 0
STUB

cat > "$HARNESS_DIR/bin/dpkg" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *--print-architecture*) printf 'arm64\n' ;;
esac
exit 0
STUB

cat > "$HARNESS_DIR/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
exit 0
STUB

cat > "$HARNESS_DIR/bin/openssl" <<'STUB'
#!/usr/bin/env bash
# openssl rand -hex N: deterministic 2N hex characters.
set -euo pipefail
if [ "${1:-}" != rand ]; then
  exit 1
fi
shift
n=""
hex=0
for arg in "$@"; do
  case "$arg" in
    -hex) hex=1 ;;
    *[!0-9]*) exit 1 ;;
    *) n=$arg ;;
  esac
done
if [ "$hex" -ne 1 ] || [ -z "$n" ]; then
  exit 1
fi
seed=$(printf 'curved-provision-smoke-%s' "$n" | sha256sum | cut -c1-64)
printf '%s\n' "${seed:0:$((n * 2))}"
STUB

cat > "$HARNESS_DIR/bin/git" <<'STUB'
#!/usr/bin/env bash
# git clone URL DEST (copies /src/deploy), and git -C DIR rev-parse.
set -euo pipefail
if [ "${1:-}" = clone ]; then
  dest=${3:-}
  if [ -z "$dest" ]; then
    exit 1
  fi
  mkdir -p "$dest/deploy" "$dest/.git"
  cp -a /src/deploy/. "$dest/deploy/"
  printf 'Cloning into %s...\n' "$dest"
  exit 0
fi
if [ "${1:-}" = -C ]; then
  dir=${2:-}
  shift 2
  if [ "${1:-}" != rev-parse ]; then
    exit 1
  fi
  if [ -d "$dir/.git" ]; then
    printf 'true\n'
    exit 0
  fi
  exit 128
fi
exit 1
STUB

cat > "$HARNESS_DIR/bin/lsblk" <<'STUB'
#!/usr/bin/env bash
# lsblk stub: root /dev/vda1 on disk vda (50 GiB), data /dev/vdb is vdb
# (100 GiB) and is only mounted once the mount stub has run.
set -euo pipefail

rev=0
diskonly=0
bytes=0
cols=""
target=""

args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg=${args[$i]}
  case "$arg" in
    --)
      i=$((i + 1))
      while [ "$i" -lt "${#args[@]}" ]; do
        target=${args[$i]}
        i=$((i + 1))
      done
      ;;
    -o|--output)
      i=$((i + 1))
      cols=${args[$i]:-}
      ;;
    --output=*)
      cols=${arg#--output=}
      ;;
    -s|--inverse)
      rev=1
      ;;
    -*)
      case "$arg" in *s*) rev=1 ;; esac
      case "$arg" in *d*) diskonly=1 ;; esac
      case "$arg" in *b*) bytes=1 ;; esac
      ;;
    *)
      target=$arg
      ;;
  esac
  i=$((i + 1))
done

name=${target##*/}
case "$name" in
  vda|vda1) ;;
  vdb|vdb[0-9]*) ;;
  *) exit 1 ;;
esac

if [ "$bytes" -eq 1 ]; then
  case "$name" in
    vda|vda1) printf '53687091200\n' ;;
    vdb|vdb[0-9]*) printf '107374182400\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi

if [ "$rev" -eq 1 ]; then
  case "$name" in
    vda1) printf 'vda1 part\nvda disk\n' ;;
    vdb) printf 'vdb disk\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi

case "$cols" in
  MOUNTPOINT)
    case "$name" in
      vda1) printf '/\n' ;;
      vdb)
        if [ -e /run/smoke/mounted ]; then
          printf '/srv/curved\n'
        fi
        ;;
    esac
    exit 0
    ;;
  TYPE)
    case "$name" in
      vda1) printf 'part\n' ;;
      vdb) printf 'disk\n' ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  NAME,TYPE)
    printf 'vda disk\nvdb disk\n'
    exit 0
    ;;
esac

if [ "$diskonly" -eq 1 ]; then
  printf 'vda disk\nvdb disk\n'
else
  printf 'vda disk\nvda1 part\nvdb disk\n'
fi
STUB

cat > "$HARNESS_DIR/bin/blockdev" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
dev=${!#}
case "$dev" in
  */vda|*/vda1) printf '53687091200\n' ;;
  */vdb|*/vdb[0-9]*) printf '107374182400\n' ;;
  *) exit 1 ;;
esac
STUB

cat > "$HARNESS_DIR/bin/blkid" <<'STUB'
#!/usr/bin/env bash
# blkid stub: ext4 with a fixed UUID, only after mkfs.ext4 has run.
set -euo pipefail
want=""
for arg in "$@"; do
  case "$arg" in
    UUID) want=uuid ;;
    TYPE) want=type ;;
  esac
done
if [ ! -e /run/smoke/fs-ext4 ]; then
  exit 2
fi
case "$want" in
  uuid) printf '6b1f4d3a-6f1a-4c1d-9a2b-0a1c2d3e4f50\n' ;;
  type) printf 'ext4\n' ;;
  *) exit 2 ;;
esac
STUB

cat > "$HARNESS_DIR/bin/mkfs.ext4" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
touch /run/smoke/fs-ext4
printf 'mke2fs 1.47.0 (stub)\n'
STUB

cat > "$HARNESS_DIR/bin/mount" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 2 ]; then
  exit 1
fi
touch /run/smoke/mounted
STUB

cat > "$HARNESS_DIR/bin/mountpoint" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
path=""
for arg in "$@"; do
  case "$arg" in
    /*) path=$arg ;;
  esac
done
if [ "$path" = /srv/curved ] && [ -e /run/smoke/mounted ]; then
  exit 0
fi
exit 1
STUB

cat > "$HARNESS_DIR/bin/findmnt" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
cols=""
target=""
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg=${args[$i]}
  case "$arg" in
    -o|--output)
      i=$((i + 1))
      cols=${args[$i]:-}
      ;;
    --output=*)
      cols=${arg#--output=}
      ;;
    --target|-T)
      i=$((i + 1))
      target=${args[$i]:-}
      ;;
    --target=*)
      target=${arg#--target=}
      ;;
  esac
  i=$((i + 1))
done

case "$target" in
  /)
    case "$cols" in
      SOURCE) printf '/dev/vda1\n' ;;
      *) printf '/ ext4 /dev/vda1\n' ;;
    esac
    exit 0
    ;;
  /srv/curved)
    if [ ! -e /run/smoke/mounted ]; then
      exit 1
    fi
    case "$cols" in
      SOURCE) printf '/dev/vdb\n' ;;
      *) printf '/srv/curved ext4 /dev/vdb\n' ;;
    esac
    exit 0
    ;;
esac
exit 1
STUB

cat > "$HARNESS_DIR/bin/df" <<'STUB'
#!/usr/bin/env bash
# df -B1 --output=size PATH: same byte counts as lsblk.
set -euo pipefail
path=${!#}
case "$path" in
  /srv/curved*) size=107374182400 ;;
  *) size=53687091200 ;;
esac
printf 'Size\n%s\n' "$size"
STUB

cat > "$HARNESS_DIR/bin/docker" <<'STUB'
#!/usr/bin/env bash
# docker stub: compose version, compose up (counted), compose ps (healthy).
set -euo pipefail
state=/run/smoke
if [ "${1:-}" != compose ]; then
  exit 1
fi
shift
case "${1:-}" in
  version)
    printf 'Docker Compose version v2.29.7\n'
    exit 0
    ;;
esac
up=0
ps=0
for arg in "$@"; do
  case "$arg" in
    up) up=1 ;;
    ps) ps=1 ;;
  esac
done
if [ "$up" -eq 1 ]; then
  count=0
  if [ -f "$state/docker-up-count" ]; then
    count=$(cat "$state/docker-up-count")
  fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$state/docker-up-count"
  printf 'stack up\n'
  exit 0
fi
if [ "$ps" -eq 1 ]; then
  printf 'db running healthy\napp running healthy\ncaddy running\n'
  exit 0
fi
exit 0
STUB

cat > "$HARNESS_DIR/bin/ss" <<'STUB'
#!/usr/bin/env bash
# ss stub: the allowed listener set; public 5432 only behind a flag.
set -euo pipefail
proto=tcp
for arg in "$@"; do
  case "$arg" in
    -*u*) proto=udp ;;
    -*t*) proto=tcp ;;
  esac
done
if [ "$proto" = udp ]; then
  printf 'UNCONN 0 0 0.0.0.0:443 0.0.0.0:*\n'
  printf 'UNCONN 0 0 0.0.0.0:68 0.0.0.0:*\n'
  printf 'UNCONN 0 0 0.0.0.0:546 0.0.0.0:*\n'
  exit 0
fi
printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n'
printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*\n'
printf 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\n'
printf 'LISTEN 0 4096 127.0.0.1:55432 0.0.0.0:*\n'
if [ -e /run/smoke/public-5432 ]; then
  printf 'LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\n'
fi
STUB

cat > "$HARNESS_DIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
# curl stub: Bearer requests get 200, anonymous requests 401.
set -euo pipefail
if [ -e /run/smoke/curl-500 ]; then
  printf '500\n'
  exit 0
fi
auth=0
for arg in "$@"; do
  case "$arg" in
    'Authorization: Bearer '*) auth=1 ;;
  esac
done
if [ "$auth" -eq 1 ]; then
  printf '200\n'
else
  printf '401\n'
fi
STUB

cat > "$HARNESS_DIR/bin/sshd" <<'STUB'
#!/usr/bin/env bash
# sshd stub: -t succeeds, -T prints effective settings read from the drop-in.
set -euo pipefail
mode=${1:-}
case "$mode" in
  -T) ;;
  *) exit 0 ;;
esac
conf=/etc/ssh/sshd_config.d/00-curved-access.conf
password=no
kbd=no
pubkey=yes
rootlogin=no
allowusers='ubuntu deploy'
if [ -f "$conf" ]; then
  while read -r key value rest; do
    if [ -z "$key" ]; then
      continue
    fi
    case "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" in
      passwordauthentication) password=$value ;;
      kbdinteractiveauthentication) kbd=$value ;;
      pubkeyauthentication) pubkey=$value ;;
      permitrootlogin) rootlogin=$value ;;
      allowusers) allowusers="$value $rest" ;;
    esac
  done < "$conf"
fi
if [ -e /run/smoke/password-auth ]; then
  password=yes
fi
printf 'port 22\n'
printf 'passwordauthentication %s\n' "$password"
printf 'kbdinteractiveauthentication %s\n' "$kbd"
printf 'pubkeyauthentication %s\n' "$pubkey"
printf 'permitrootlogin %s\n' "$rootlogin"
printf 'allowusers %s\n' "$allowusers"
STUB

chmod 0755 "$HARNESS_DIR"/bin/*

# The harness is mounted read-only, so the deterministic public key ships with
# it and is visible inside the container as /smoke/id.pub.
cat > "$HARNESS_DIR/id.pub" <<'KEY'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA curved-provision-smoke@curved.test
KEY
chmod 0644 "$HARNESS_DIR/id.pub"

cat > "$HARNESS_DIR/scenario.sh" <<'SCENARIO'
#!/usr/bin/env bash
# Container-side scenario for scripts/provision-smoke.sh. Runs as root in a
# disposable ubuntu:24.04 container with the stubs from /smoke/bin on PATH.
set -euo pipefail

STATE=/run/smoke
ROOT=/src
KEY=/smoke/id.pub
BOOTSTRAP=$ROOT/deploy/bootstrap-host.sh
VERIFIER=$ROOT/deploy/verify-host.sh
MOUNT=/srv/curved
CHECKOUT=$MOUNT/checkout
ENV_FILE=$CHECKOUT/deploy/.env

pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'provision-smoke: FAIL %s\n' "$1" >&2
  exit 1
}

state_reset() { rm -rf "$STATE"; mkdir -p "$STATE"; chmod 0777 "$STATE"; }

# 1. Install the stubs, create the fake block devices, and check the key.
state_reset
install -m 0755 /smoke/bin/* /usr/local/bin/
mknod /dev/vda1 b 254 1
mknod /dev/vdb b 254 16
touch /etc/fstab
[ -s "$KEY" ] || fail "missing $KEY"
if ! grep -q '^ssh-ed25519 ' "$KEY"; then
  fail "$KEY is not an Ed25519 public key"
fi
pass "stubs, fake block devices, and key installed"

# 2. Fresh bootstrap with the stack enabled.
boot_out="$STATE/bootstrap-fresh.out"
boot_err="$STATE/bootstrap-fresh.err"
if ! bash "$BOOTSTRAP" --key "$KEY" --data-device /dev/vdb --domain curved.test \
  >"$boot_out" 2>"$boot_err"; then
  cat "$boot_out" "$boot_err" >&2
  fail "fresh bootstrap exited non-zero"
fi
grep -qx 'bootstrap-host: ok' "$boot_out" || fail "fresh bootstrap did not print bootstrap-host: ok"
pass "bootstrap fresh (exit 0, bootstrap-host: ok)"

entry=$(getent passwd deploy || true)
[ -n "$entry" ] || fail "deploy user does not exist"
[ "${entry##*:}" = /bin/bash ] || fail "deploy shell is ${entry##*:}, expected /bin/bash"
if ! id -nG deploy | tr ' ' '\n' | grep -qx docker; then
  fail "deploy is not in the docker group"
fi
pass "deploy user (/bin/bash, docker group)"

[ "$(stat -c '%a %U' /home/deploy/.ssh)" = '700 deploy' ] \
  || fail "/home/deploy/.ssh is not mode 700 owned by deploy"
[ "$(stat -c '%a %U' /home/deploy/.ssh/authorized_keys)" = '600 deploy' ] \
  || fail "authorized_keys is not mode 600 owned by deploy"
if ! grep -Fxq "$(cat "$KEY")" /home/deploy/.ssh/authorized_keys; then
  fail "authorized_keys does not contain the key"
fi
pass "deploy ssh access (700 dir, 600 keys, key installed)"

sshd_conf=/etc/ssh/sshd_config.d/00-curved-access.conf
for line in \
  'PubkeyAuthentication yes' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PermitRootLogin no' \
  'AllowUsers ubuntu deploy'; do
  if ! grep -Fxq "$line" "$sshd_conf"; then
    fail "sshd drop-in is missing: $line"
  fi
done
pass "sshd access policy (four lines plus AllowUsers)"

fstab_count=$(grep -Ec '^UUID=[^ ]+ /srv/curved ext4 ' /etc/fstab || true)
[ "$fstab_count" = 1 ] || fail "fstab has $fstab_count UUID entries for $MOUNT, expected 1"
[ -e "$STATE/mounted" ] || fail "the data volume mount marker is missing"
pass "data volume (ext4 mounted, one fstab entry)"

[ -d "$CHECKOUT/.git" ] || fail "$CHECKOUT is not a git checkout"
[ "$(stat -c '%U' "$CHECKOUT")" = deploy ] || fail "$CHECKOUT is not owned by deploy"
pass "checkout (git work tree owned by deploy)"

[ -f "$ENV_FILE" ] || fail "missing $ENV_FILE"
[ "$(stat -c '%a %U' "$ENV_FILE")" = '600 deploy' ] \
  || fail "$ENV_FILE is not mode 600 owned by deploy"
if grep -q 'change-me' "$ENV_FILE"; then
  fail "$ENV_FILE still contains change-me placeholders"
fi
grep -qx 'COOKIE_SECURE=1' "$ENV_FILE" || fail "COOKIE_SECURE is not 1"
grep -qx 'CURVED_DOMAIN=curved.test' "$ENV_FILE" || fail "CURVED_DOMAIN is not curved.test"
grep -qx 'POSTGRES_USER=curved' "$ENV_FILE" || fail "POSTGRES_USER is not curved"
grep -qx 'POSTGRES_DB=curved' "$ENV_FILE" || fail "POSTGRES_DB is not curved"
grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$ENV_FILE" || fail "POSTGRES_PASSWORD is not a generated secret"
grep -Eq '^CURVED_UI_TOKEN=[0-9a-f]{64}$' "$ENV_FILE" || fail "CURVED_UI_TOKEN is not a generated secret"
grep -Eq '^GITHUB_WEBHOOK_SECRET=[0-9a-f]{64}$' "$ENV_FILE" || fail "GITHUB_WEBHOOK_SECRET is not a generated secret"
pass "environment (mode 600 owned by deploy, real values)"

for key in POSTGRES_PASSWORD CURVED_UI_TOKEN GITHUB_WEBHOOK_SECRET; do
  value=$(sed -n "s/^$key=//p" "$ENV_FILE")
  [ -n "$value" ] || fail "$key is empty"
  if grep -Fq "$value" "$boot_out"; then
    fail "$key leaked to stdout"
  fi
done
pass "no generated secret on stdout"

[ "$(cat "$STATE/docker-up-count" 2>/dev/null || printf 0)" = 1 ] \
  || fail "docker compose up ran $(cat "$STATE/docker-up-count" 2>/dev/null || printf 0) time(s), expected 1"
pass "stack started once"

# 3. Idempotent re-run with the same arguments.
env_hash=$(sha256sum "$ENV_FILE" | cut -d' ' -f1)
keys_lines=$(wc -l < /home/deploy/.ssh/authorized_keys)
fstab_lines=$(wc -l < /etc/fstab)
boot_out="$STATE/bootstrap-rerun.out"
boot_err="$STATE/bootstrap-rerun.err"
if ! bash "$BOOTSTRAP" --key "$KEY" --data-device /dev/vdb --domain curved.test \
  >"$boot_out" 2>"$boot_err"; then
  cat "$boot_out" "$boot_err" >&2
  fail "idempotent re-run exited non-zero"
fi
grep -qx 'bootstrap-host: ok' "$boot_out" || fail "idempotent re-run did not print bootstrap-host: ok"
[ "$(sha256sum "$ENV_FILE" | cut -d' ' -f1)" = "$env_hash" ] || fail "the re-run rewrote $ENV_FILE"
[ "$(wc -l < /home/deploy/.ssh/authorized_keys)" = "$keys_lines" ] \
  || fail "the re-run changed the authorized_keys line count"
[ "$(wc -l < /etc/fstab)" = "$fstab_lines" ] || fail "the re-run changed the fstab line count"
[ "$(getent passwd deploy | wc -l)" -eq 1 ] || fail "the re-run duplicated the deploy user"
pass "idempotent rerun (env hash, key and fstab counts, single user)"

# 4. Verifier happy path.
verify_out="$STATE/verify-positive.log"
verify_rc=0
bash "$VERIFIER" >"$verify_out" 2>&1 || verify_rc=$?
if [ "$verify_rc" -ne 0 ]; then
  cat "$verify_out" >&2
  fail "verify-host rejected the bootstrapped host (exit $verify_rc)"
fi
[ "$(tail -n 1 "$verify_out")" = 'verify-host: ok' ] || fail "verify-host did not end with verify-host: ok"
if grep -q '^FAIL' "$verify_out"; then
  cat "$verify_out" >&2
  fail "verify-host printed FAIL lines on the happy path"
fi
pass "verify-host positive (exit 0, verify-host: ok, no FAIL)"

# 5. Negative boundary: a public Postgres listener must be rejected.
touch "$STATE/public-5432"
verify_out="$STATE/verify-public-5432.log"
verify_rc=0
bash "$VERIFIER" >"$verify_out" 2>&1 || verify_rc=$?
rm -f "$STATE/public-5432"
if [ "$verify_rc" -ne 1 ]; then
  cat "$verify_out" >&2
  fail "public 5432: verify-host exited $verify_rc, expected 1"
fi
if ! grep -Eq '^FAIL .*5432' "$verify_out"; then
  cat "$verify_out" >&2
  fail "public 5432: no FAIL line names 5432"
fi
pass "negative: public 5432 rejected"

# 6. Negative boundary: password authentication must be rejected.
touch "$STATE/password-auth"
verify_out="$STATE/verify-password-auth.log"
verify_rc=0
bash "$VERIFIER" >"$verify_out" 2>&1 || verify_rc=$?
rm -f "$STATE/password-auth"
if [ "$verify_rc" -ne 1 ]; then
  cat "$verify_out" >&2
  fail "password auth: verify-host exited $verify_rc, expected 1"
fi
if ! grep -Eq '^FAIL .*passwordauthentication is yes' "$verify_out"; then
  cat "$verify_out" >&2
  fail "password auth: no FAIL line names password authentication"
fi
pass "negative: password authentication rejected"

# 7. --no-stack re-run starts nothing.
up_before=$(cat "$STATE/docker-up-count" 2>/dev/null || printf 0)
boot_out="$STATE/bootstrap-nostack.out"
boot_err="$STATE/bootstrap-nostack.err"
if ! bash "$BOOTSTRAP" --key "$KEY" --data-device /dev/vdb --domain curved.test --no-stack \
  >"$boot_out" 2>"$boot_err"; then
  cat "$boot_out" "$boot_err" >&2
  fail "--no-stack re-run exited non-zero"
fi
grep -qx 'bootstrap-host: ok' "$boot_out" || fail "--no-stack re-run did not print bootstrap-host: ok"
up_after=$(cat "$STATE/docker-up-count" 2>/dev/null || printf 0)
[ "$up_after" = "$up_before" ] || fail "--no-stack ran docker compose up $((up_after - up_before)) time(s)"
pass "no-stack rerun (compose up count unchanged)"

# 8. A private-key-looking --key line is rejected without touching authorized_keys.
keys_hash=$(sha256sum /home/deploy/.ssh/authorized_keys | cut -d' ' -f1)
bad_key=$STATE/bad-key
printf '%s\n' '-----BEGIN OPENSSH PRIVATE KEY-----' >"$bad_key"
boot_out="$STATE/bootstrap-bad-key.out"
boot_err="$STATE/bootstrap-bad-key.err"
verify_rc=0
bash "$BOOTSTRAP" --key "$bad_key" --data-device /dev/vdb --domain curved.test --no-stack \
  >"$boot_out" 2>"$boot_err" || verify_rc=$?
if [ "$verify_rc" -eq 0 ]; then
  fail "private-key input was accepted"
fi
if ! grep -q 'not an OpenSSH public key' "$boot_err"; then
  cat "$boot_out" "$boot_err" >&2
  fail "private-key input did not name the key error"
fi
[ "$(sha256sum /home/deploy/.ssh/authorized_keys | cut -d' ' -f1)" = "$keys_hash" ] \
  || fail "a rejected key changed authorized_keys"
pass "negative: non-public --key rejected"
SCENARIO
chmod 0755 "$HARNESS_DIR/scenario.sh"

if ! docker run --rm --name "$CONTAINER_NAME" \
  -v "$ROOT_DIR:/src:ro" \
  -v "$HARNESS_DIR:/smoke:ro" \
  "$IMAGE" bash /smoke/scenario.sh; then
  fail "container scenario failed"
fi

printf 'provision-smoke: ok\n'
if [ "$keep" -eq 1 ]; then
  printf 'provision-smoke: kept harness %s\n' "$HARNESS_DIR"
fi
