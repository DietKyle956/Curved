#!/usr/bin/env bash
# Read-only acceptance verifier for the Oracle Cloud host that runs the Curved
# production stack. Every check runs even when an earlier one fails, so one
# invocation reports the complete set of host defects.
set -uo pipefail

CHECKOUT_DIR="/srv/curved/checkout"
MOUNT_DIR="/srv/curved"
DOMAIN=""
DOMAIN_GIVEN=0
SKIP_STACK=0
ENV_FILE=""
UI_TOKEN=""
ACME_EMAIL=""
PUBLIC_TLS=0
FAILED=0

usage() {
  cat <<'EOF'
Usage: sudo bash deploy/verify-host.sh [options]

Read-only acceptance checks for the Oracle Cloud host that runs the Curved
production stack. Each check prints PASS or FAIL; the script exits 1 when any
check fails, so a single run reports every defect.

Options:
  --checkout-dir DIR  Repository checkout (default /srv/curved/checkout).
  --mount-dir DIR     Data volume mount point (default /srv/curved).
  --domain NAME       Hostname probed over HTTPS. Defaults to CURVED_DOMAIN
                      from <checkout>/deploy/.env, then localhost.
  --skip-stack        Skip the Docker Compose, edge TLS, HTTPS API, and webhook
                      checks. Every host check, including the Docker data-root
                      checks, runs.
  -h, --help          Show this message and exit.

Checks, in order: os, deploy-user, deploy-ssh-dir, deploy-authorized-keys,
sshd-config, data-mount, storage, docker-root (daemon data root is on the data
volume), docker-config (daemon.json data root, log rotation, build-cache GC),
docker-mount-dependency (drop-in and docker.service mount ordering),
docker-prune-timer (curved-docker-prune units enabled and active),
keepalive-timer (curved-keepalive units enabled and active with the script installed),
backup-dir (0700 owned by deploy), backup-timer (curved-backup units installed,
enabled and active), backup-freshness (newest nightly set at most 93600s old
with a non-empty postgres.dump), backup-integrity (newest set verifies against
SHA256SUMS), env-file,
checkout, tcp-listeners, udp-listeners, then stack, tls-certificate,
http-redirect, hsts, compression, caddy-issuance, https-api, and webhook
unless --skip-stack is given.

Public TLS is assumed only when ACME_EMAIL is non-empty in the environment
file and the domain is not localhost; otherwise Caddy's internal CA is
expected and certificate checks run with -k.

Requires root: sshd -T needs it, and deploy/.env is mode 600. Secret values
from the environment file are never printed.
EOF
}

argument_error() {
  printf 'verify-host: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL %s\n' "$1"
}

fail_list() {
  local name=$1
  shift
  local reason
  reason=$(printf '%s; ' "$@")
  fail "$name: ${reason%; }"
}

read_env() {
  local key=$1
  local line value
  [ -r "$ENV_FILE" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      "$key"=*) ;;
      *) continue ;;
    esac
    value=${line#*=}
    if [ "${#value}" -ge 2 ]; then
      case "$value" in
        \"*\") value=${value:1:${#value}-2} ;;
        \'*\') value=${value:1:${#value}-2} ;;
      esac
    fi
    printf '%s' "$value"
    return 0
  done < "$ENV_FILE"
  return 1
}

# Certificate checks run without -k only for public ACME certificates, where
# the chain must verify against the system trust store.
curl_tls() {
  if [ "$PUBLIC_TLS" -eq 1 ]; then
    curl -sS "$@"
  else
    curl -ksS "$@"
  fi
}

encoding_of() {
  local value=""
  value=$(printf '%s\n' "$1" | grep -i '^content-encoding:' | head -n 1 \
    | tr '[:upper:]' '[:lower:]' || true)
  case "$value" in
    *gzip*) printf 'gzip' ;;
    *zstd*) printf 'zstd' ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --checkout-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a directory"
      fi
      case "$2" in
        -*) argument_error "$1 requires a directory, got $2" ;;
      esac
      CHECKOUT_DIR=$2
      shift 2
      ;;
    --mount-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a directory"
      fi
      case "$2" in
        -*) argument_error "$1 requires a directory, got $2" ;;
      esac
      MOUNT_DIR=$2
      shift 2
      ;;
    --domain)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a hostname"
      fi
      case "$2" in
        -*) argument_error "$1 requires a hostname, got $2" ;;
      esac
      DOMAIN=$2
      DOMAIN_GIVEN=1
      shift 2
      ;;
    --skip-stack)
      SKIP_STACK=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      argument_error "unknown argument $1"
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  printf 'verify-host: run as root: sudo bash deploy/verify-host.sh\n' >&2
  exit 1
fi

CHECKOUT_DIR=$(realpath -m -- "$CHECKOUT_DIR")
MOUNT_DIR=$(realpath -m -- "$MOUNT_DIR")
DOCKER_ROOT="$MOUNT_DIR/docker"
ENV_FILE="$CHECKOUT_DIR/deploy/.env"

if [ "$DOMAIN_GIVEN" -eq 0 ]; then
  DOMAIN=$(read_env CURVED_DOMAIN || true)
  if [ -z "$DOMAIN" ]; then
    DOMAIN="localhost"
  fi
fi
UI_TOKEN=$(read_env CURVED_UI_TOKEN || true)
ACME_EMAIL=$(read_env ACME_EMAIL || true)
if [ -n "$ACME_EMAIL" ] && [ "$DOMAIN" != localhost ]; then
  PUBLIC_TLS=1
fi

check_os() {
  local id=""
  local version=""
  if [ ! -r /etc/os-release ]; then
    fail_list os "/etc/os-release is not readable"
    return
  fi
  id=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)
  version=$(awk -F= '$1 == "VERSION_ID" { gsub(/"/, "", $2); print $2; exit }' /etc/os-release)
  if [ "$id" = ubuntu ] && [ "$version" = 24.04 ]; then
    pass "os: Ubuntu 24.04"
  else
    fail_list os "expected Ubuntu 24.04, found ${id:-unknown} ${version:-unknown}"
  fi
}

check_deploy_user() {
  local entry=""
  local shell=""
  local groups=""
  local reasons=()
  entry=$(getent passwd deploy || true)
  if [ -z "$entry" ]; then
    fail_list deploy-user "user deploy does not exist"
    return
  fi
  shell=${entry##*:}
  groups=$(id -nG deploy 2>/dev/null || true)
  if [ "$shell" != /bin/bash ]; then
    reasons+=("shell is ${shell:-unknown}, expected /bin/bash")
  fi
  case " $groups " in
    *" docker "*) ;;
    *) reasons+=("not in the docker group") ;;
  esac
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list deploy-user "${reasons[@]}"
  else
    pass "deploy-user: deploy has /bin/bash and is in the docker group (root-equivalent, documented)"
  fi
}

check_ssh_dir() {
  local dir="/home/deploy/.ssh"
  local st=""
  local mode=""
  local owner=""
  local reasons=()
  if [ ! -d "$dir" ]; then
    fail_list deploy-ssh-dir "missing $dir"
    return
  fi
  if st=$(stat -c '%a %U' -- "$dir" 2>/dev/null); then
    read -r mode owner <<<"$st"
  else
    reasons+=("cannot stat $dir")
  fi
  if [ "$mode" != 700 ]; then
    reasons+=("mode is ${mode:-unknown}, expected 700")
  fi
  if [ "$owner" != deploy ]; then
    reasons+=("owner is ${owner:-unknown}, expected deploy")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list deploy-ssh-dir "${reasons[@]}"
  else
    pass "deploy-ssh-dir: $dir is mode 700 owned by deploy"
  fi
}

check_authorized_keys() {
  local keys="/home/deploy/.ssh/authorized_keys"
  local st=""
  local mode=""
  local owner=""
  local size=""
  local reasons=()
  if [ ! -e "$keys" ]; then
    fail_list deploy-authorized-keys "missing $keys"
    return
  fi
  if st=$(stat -c '%a %U %s' -- "$keys" 2>/dev/null); then
    read -r mode owner size <<<"$st"
  else
    reasons+=("cannot stat $keys")
  fi
  if [ "$mode" != 600 ]; then
    reasons+=("mode is ${mode:-unknown}, expected 600")
  fi
  if [ "$owner" != deploy ]; then
    reasons+=("owner is ${owner:-unknown}, expected deploy")
  fi
  case "$size" in
    '' | *[!0-9]* | 0) reasons+=("file is empty") ;;
  esac
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list deploy-authorized-keys "${reasons[@]}"
  else
    pass "deploy-authorized-keys: $keys is mode 600, owned by deploy, and non-empty"
  fi
}

check_sshd() {
  local sshd_bin=""
  local out=""
  local key=""
  local expected=""
  local actual=""
  local reasons=()
  sshd_bin=$(command -v sshd || true)
  if [ -z "$sshd_bin" ] && [ -x /usr/sbin/sshd ]; then
    sshd_bin=/usr/sbin/sshd
  fi
  if [ -z "$sshd_bin" ]; then
    fail_list sshd-config "sshd is not installed"
    return
  fi
  if ! out=$("$sshd_bin" -T 2>/dev/null); then
    fail_list sshd-config "sshd -T failed (missing host keys or invalid configuration)"
    return
  fi
  while read -r key expected; do
    if [ -z "$key" ]; then
      continue
    fi
    actual=$(awk -v k="$key" '$1 == k { print $2; exit }' <<<"$out")
    if [ "$actual" != "$expected" ]; then
      reasons+=("$key is ${actual:-unset}, expected $expected")
    fi
  done <<'EOF'
passwordauthentication no
kbdinteractiveauthentication no
pubkeyauthentication yes
permitrootlogin no
EOF
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list sshd-config "${reasons[@]}"
  else
    pass "sshd-config: password and keyboard-interactive auth off, public keys only, root login disabled"
  fi
}

check_data_mount() {
  local line=""
  local target=""
  local fstype=""
  local source=""
  local root_source=""
  local reasons=()
  if ! line=$(findmnt -n -o TARGET,FSTYPE,SOURCE --target "$MOUNT_DIR" 2>/dev/null); then
    fail_list data-mount "no mount found for $MOUNT_DIR"
    return
  fi
  read -r target fstype source <<<"$line"
  root_source=$(findmnt -n -o SOURCE --target / 2>/dev/null || true)
  if [ "$target" != "$MOUNT_DIR" ]; then
    reasons+=("target is ${target:-unknown}, expected $MOUNT_DIR")
  fi
  if [ "$fstype" != ext4 ]; then
    reasons+=("fstype is ${fstype:-unknown}, expected ext4")
  fi
  if [ -z "$source" ]; then
    reasons+=("source is unknown")
  elif [ "$source" = "$root_source" ]; then
    reasons+=("source $source is the root device")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list data-mount "${reasons[@]}"
  else
    pass "data-mount: $MOUNT_DIR is ext4 on $source (root on ${root_source:-unknown})"
  fi
}

df_size() {
  local path=$1
  local size=""
  size=$(df -B1 --output=size -- "$path" 2>/dev/null | awk 'NR == 2 { print $1 }')
  case "$size" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$size"
}

block_size() {
  local source=$1
  local fallback_path=$2
  local size=""
  if command -v lsblk >/dev/null 2>&1; then
    size=$(lsblk -bdno SIZE -- "$source" 2>/dev/null)
    case "$size" in
      '' | *[!0-9]*) ;;
      *)
        printf '%s' "$size"
        return 0
        ;;
    esac
  fi
  df_size "$fallback_path"
}

check_storage() {
  local gib=1073741824
  local root_source=""
  local data_source=""
  local boot=""
  local data=""
  local total=""
  local summary=""
  local reasons=()
  root_source=$(findmnt -n -o SOURCE --target / 2>/dev/null || true)
  data_source=$(findmnt -n -o SOURCE --target "$MOUNT_DIR" 2>/dev/null || true)
  if [ -z "$root_source" ]; then
    fail_list storage "cannot resolve the root block device"
    return
  fi
  if [ -z "$data_source" ]; then
    fail_list storage "cannot resolve the block device for $MOUNT_DIR"
    return
  fi
  if ! boot=$(block_size "$root_source" /); then
    fail_list storage "cannot size the root device $root_source"
    return
  fi
  if ! data=$(block_size "$data_source" "$MOUNT_DIR"); then
    fail_list storage "cannot size the data device $data_source"
    return
  fi
  total=$((boot + data))
  summary=$(awk -v b="$boot" -v d="$data" -v t="$total" \
    'BEGIN { printf "boot %.1f GiB, data %.1f GiB, total %.1f GiB", b / 1073741824, d / 1073741824, t / 1073741824 }')
  if [ "$data" -lt $((90 * gib)) ] || [ "$data" -gt $((110 * gib)) ]; then
    reasons+=("data is outside 90-110 GiB")
  fi
  if [ "$boot" -lt $((45 * gib)) ] || [ "$boot" -gt $((60 * gib)) ]; then
    reasons+=("boot is outside 45-60 GiB")
  fi
  if [ "$total" -lt $((140 * gib)) ] || [ "$total" -gt $((200 * gib)) ]; then
    reasons+=("total is outside 140-200 GiB")
  fi
  if [ "$total" -lt $((data + boot)) ]; then
    reasons+=("total is below data plus boot")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    reasons+=("sizes: $summary")
    fail_list storage "${reasons[@]}"
  else
    pass "storage: $summary"
  fi
}

check_docker_root() {
  local expected=""
  local root=""
  local target=""
  local reasons=()
  expected=$(realpath -m -- "$DOCKER_ROOT" 2>/dev/null || true)
  expected=${expected%/}
  if [ -z "$expected" ]; then
    fail_list docker-root "cannot resolve $DOCKER_ROOT"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    fail_list docker-root "docker is not installed"
    return
  fi
  if ! root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null); then
    fail_list docker-root "docker info --format '{{.DockerRootDir}}' failed (docker may not be running)"
    return
  fi
  root=${root%/}
  if [ "$root" != "$expected" ]; then
    reasons+=("docker data root is ${root:-empty}, expected $expected")
  fi
  if [ ! -d "$expected" ]; then
    reasons+=("missing directory $expected")
  fi
  target=$(findmnt -n -o TARGET --target "$expected" 2>/dev/null || true)
  if [ "$target" != "$MOUNT_DIR" ]; then
    reasons+=("$expected is on ${target:-no mount}, expected $MOUNT_DIR")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list docker-root "${reasons[@]}"
  else
    pass "docker-root: $root is on $MOUNT_DIR"
  fi
}

check_docker_config() {
  local path="/etc/docker/daemon.json"
  local want=""
  local reasons=()
  if [ ! -f "$path" ]; then
    fail_list docker-config "missing $path"
    return
  fi
  while IFS= read -r want; do
    if ! grep -Fq -- "$want" "$path" 2>/dev/null; then
      reasons+=("$path lacks $want")
    fi
  done <<EOF
"data-root": "$DOCKER_ROOT"
"log-driver": "json-file"
"max-size": "10m"
"max-file": "3"
"defaultKeepStorage": "5GB"
EOF
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list docker-config "${reasons[@]}"
  else
    pass "docker-config: $path sets data-root $DOCKER_ROOT, json-file rotation 10m x 3, and build-cache GC keeping 5GB"
  fi
}

check_docker_mount_dependency() {
  local dropin="/etc/systemd/system/docker.service.d/10-curved-data-root.conf"
  local mounts=""
  local state=""
  local reasons=()
  if [ ! -f "$dropin" ]; then
    fail_list docker-mount-dependency "missing $dropin"
    return
  fi
  if ! grep -Fqx -- "RequiresMountsFor=$DOCKER_ROOT" "$dropin" 2>/dev/null; then
    reasons+=("$dropin lacks RequiresMountsFor=$DOCKER_ROOT")
  fi
  if ! grep -Fqx -- "ConditionPathIsMountPoint=$MOUNT_DIR" "$dropin" 2>/dev/null; then
    reasons+=("$dropin lacks ConditionPathIsMountPoint=$MOUNT_DIR")
  fi
  mounts=$(systemctl show docker.service -p RequiresMountsFor --value 2>/dev/null || true)
  case " $mounts " in
    *" $DOCKER_ROOT "*) ;;
    *) reasons+=("docker.service RequiresMountsFor is ${mounts:-empty}, expected $DOCKER_ROOT") ;;
  esac
  state=$(systemctl is-enabled docker 2>/dev/null || true)
  if [ "$state" != enabled ]; then
    reasons+=("docker is ${state:-not enabled}, expected enabled")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list docker-mount-dependency "${reasons[@]}"
  else
    pass "docker-mount-dependency: $dropin requires the mount for $DOCKER_ROOT and docker is enabled"
  fi
}

check_docker_prune_timer() {
  local unit="/etc/systemd/system/curved-docker-prune.service"
  local timer="/etc/systemd/system/curved-docker-prune.timer"
  local state=""
  local active=""
  local reasons=()
  if [ ! -f "$unit" ]; then
    reasons+=("missing $unit")
  fi
  if [ ! -f "$timer" ]; then
    reasons+=("missing $timer")
  elif ! grep -q '^OnCalendar=' "$timer" 2>/dev/null; then
    reasons+=("$timer has no OnCalendar= line")
  fi
  state=$(systemctl is-enabled curved-docker-prune.timer 2>/dev/null || true)
  if [ "$state" != enabled ]; then
    reasons+=("curved-docker-prune.timer is ${state:-not installed}, expected enabled")
  fi
  active=$(systemctl is-active curved-docker-prune.timer 2>/dev/null || true)
  if [ "$active" != active ]; then
    reasons+=("curved-docker-prune.timer is ${active:-inactive}, expected active")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list docker-prune-timer "${reasons[@]}"
  else
    pass "docker-prune-timer: curved-docker-prune.timer is enabled and active with a daily OnCalendar schedule"
  fi
}

check_keepalive_timer() {
  local unit="/etc/systemd/system/curved-keepalive.service"
  local timer="/etc/systemd/system/curved-keepalive.timer"
  local script="/usr/local/bin/curved-keepalive"
  local state=""
  local active=""
  local reasons=()
  if [ ! -f "$unit" ]; then
    reasons+=("missing $unit")
  else
    if ! grep -q '^ExecStart=/usr/local/bin/curved-keepalive$' "$unit" 2>/dev/null; then
      reasons+=("$unit has no ExecStart=/usr/local/bin/curved-keepalive line")
    fi
    if ! grep -q '^Nice=19$' "$unit" 2>/dev/null; then
      reasons+=("$unit has no Nice=19 line")
    fi
  fi
  if [ ! -f "$timer" ]; then
    reasons+=("missing $timer")
  elif ! grep -q '^OnCalendar=hourly$' "$timer" 2>/dev/null; then
    reasons+=("$timer has no OnCalendar=hourly line")
  fi
  if [ ! -f "$script" ]; then
    reasons+=("missing $script")
  elif [ ! -x "$script" ]; then
    reasons+=("$script is not executable")
  fi
  state=$(systemctl is-enabled curved-keepalive.timer 2>/dev/null || true)
  if [ "$state" != enabled ]; then
    reasons+=("curved-keepalive.timer is ${state:-not installed}, expected enabled")
  fi
  active=$(systemctl is-active curved-keepalive.timer 2>/dev/null || true)
  if [ "$active" != active ]; then
    reasons+=("curved-keepalive.timer is ${active:-inactive}, expected active")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list keepalive-timer "${reasons[@]}"
  else
    pass "keepalive-timer: curved-keepalive.timer is enabled and active with an hourly OnCalendar schedule and an executable keepalive script"
  fi
}

# newest_backup_set DIR prints the newest timestamped directory under DIR, or
# nothing when the directory holds no sets. Dot directories are staging or
# lock state, never published sets.
newest_backup_set() {
  local kind_dir=$1
  local set=""
  local newest=""
  for set in "$kind_dir"/*; do
    [ -d "$set" ] || continue
    if [ -L "$set" ]; then
      continue
    fi
    case "${set##*/}" in
      .*) continue ;;
    esac
    newest=$set
  done
  printf '%s' "$newest"
}

check_backup_dir() {
  local dir="$MOUNT_DIR/backups"
  local st=""
  local mode=""
  local owner=""
  local reasons=()
  if [ ! -d "$dir" ]; then
    fail_list backup-dir "missing directory $dir"
    return
  fi
  if st=$(stat -c '%a %U' -- "$dir" 2>/dev/null); then
    read -r mode owner <<<"$st"
  else
    reasons+=("cannot stat $dir")
  fi
  if [ "$mode" != 700 ]; then
    reasons+=("mode is ${mode:-unknown}, expected 700")
  fi
  if [ "$owner" != deploy ]; then
    reasons+=("owner is ${owner:-unknown}, expected deploy")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list backup-dir "${reasons[@]}"
  else
    pass "backup-dir: $dir is mode 700 owned by deploy"
  fi
}

check_backup_timer() {
  local unit="/etc/systemd/system/curved-backup.service"
  local timer="/etc/systemd/system/curved-backup.timer"
  local state=""
  local active=""
  local reasons=()
  if [ ! -f "$unit" ]; then
    reasons+=("missing $unit")
  fi
  if [ ! -f "$timer" ]; then
    reasons+=("missing $timer")
  fi
  if ! systemctl is-enabled --quiet curved-backup.timer 2>/dev/null; then
    state=$(systemctl is-enabled curved-backup.timer 2>/dev/null || true)
    reasons+=("curved-backup.timer is ${state:-not installed}, expected enabled")
  fi
  if ! systemctl is-active --quiet curved-backup.timer 2>/dev/null; then
    active=$(systemctl is-active curved-backup.timer 2>/dev/null || true)
    reasons+=("curved-backup.timer is ${active:-inactive}, expected active")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list backup-timer "${reasons[@]}"
  else
    pass "backup-timer: curved-backup.timer is enabled and active"
  fi
}

check_backup_freshness() {
  local kind_dir="$MOUNT_DIR/backups/nightly"
  local newest=""
  local name=""
  local created=""
  local epoch=""
  local now=""
  local age=""
  local reasons=()
  if [ ! -d "$kind_dir" ]; then
    fail_list backup-freshness "missing directory $kind_dir"
    return
  fi
  newest=$(newest_backup_set "$kind_dir")
  if [ -z "$newest" ]; then
    fail_list backup-freshness "no backup set under $kind_dir"
    return
  fi
  name=${newest##*/}
  created=$(sed -n 's/^created_at=//p' "$newest/manifest.txt" 2>/dev/null | head -n 1 || true)
  if [ -z "$created" ]; then
    reasons+=("missing created_at in $newest/manifest.txt")
  else
    case "$created" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
      *) reasons+=("created_at $created is not YYYY-MM-DDTHH:MM:SSZ") ;;
    esac
    epoch=$(date -u -d "$created" +%s 2>/dev/null || true)
    if [ -z "$epoch" ]; then
      reasons+=("cannot parse created_at $created")
    else
      now=$(date -u +%s)
      age=$((now - epoch))
      if [ "$age" -gt 93600 ]; then
        reasons+=("newest nightly set $name is ${age}s old, expected <= 93600s")
      fi
    fi
  fi
  if [ ! -s "$newest/postgres.dump" ]; then
    reasons+=("$newest/postgres.dump is missing or empty")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list backup-freshness "${reasons[@]}"
  else
    pass "backup-freshness: newest nightly set $name is ${age}s old with a non-empty postgres.dump"
  fi
}

check_backup_integrity() {
  local kind_dir="$MOUNT_DIR/backups/nightly"
  local newest=""
  local reasons=()
  if [ ! -d "$kind_dir" ]; then
    fail_list backup-integrity "missing directory $kind_dir"
    return
  fi
  newest=$(newest_backup_set "$kind_dir")
  if [ -z "$newest" ]; then
    fail_list backup-integrity "no backup set under $kind_dir"
    return
  fi
  if [ ! -f "$newest/SHA256SUMS" ]; then
    reasons+=("missing $newest/SHA256SUMS")
  fi
  if [ ! -f "$newest/manifest.txt" ]; then
    reasons+=("missing $newest/manifest.txt")
  fi
  if [ "${#reasons[@]}" -eq 0 ]; then
    if ! (cd "$newest" && sha256sum -c --status SHA256SUMS >/dev/null 2>&1); then
      reasons+=("sha256sum -c failed for $newest/SHA256SUMS")
    fi
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list backup-integrity "${reasons[@]}"
  else
    pass "backup-integrity: $newest verifies against SHA256SUMS"
  fi
}

check_env_file() {
  local st=""
  local mode=""
  local owner=""
  local key=""
  local value=""
  local reasons=()
  local missing=()
  if [ ! -f "$ENV_FILE" ]; then
    fail_list env-file "missing $ENV_FILE"
    return
  fi
  if st=$(stat -c '%a %U' -- "$ENV_FILE" 2>/dev/null); then
    read -r mode owner <<<"$st"
  else
    reasons+=("cannot stat $ENV_FILE")
  fi
  if [ "$mode" != 600 ]; then
    reasons+=("mode is ${mode:-unknown}, expected 600")
  fi
  if [ "$owner" != deploy ]; then
    reasons+=("owner is ${owner:-unknown}, expected deploy")
  fi
  for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB CURVED_UI_TOKEN GITHUB_WEBHOOK_SECRET CURVED_DOMAIN; do
    value=$(read_env "$key" || true)
    if [ -z "$value" ]; then
      missing+=("$key")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    reasons+=("missing or empty: ${missing[*]}")
  fi
  if grep -q 'change-me' "$ENV_FILE" 2>/dev/null; then
    reasons+=("still contains change-me placeholders")
  fi
  value=$(read_env COOKIE_SECURE || true)
  if [ "$value" != 1 ]; then
    reasons+=("COOKIE_SECURE is ${value:-unset}, expected 1")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list env-file "${reasons[@]}"
  else
    pass "env-file: $ENV_FILE is mode 600 owned by deploy with required keys"
  fi
}

check_checkout() {
  local st=""
  local owner=""
  local out=""
  local reasons=()
  if [ ! -d "$CHECKOUT_DIR" ]; then
    fail_list checkout "missing directory $CHECKOUT_DIR"
    return
  fi
  if [ ! -e "$CHECKOUT_DIR/.git" ]; then
    reasons+=("no .git entry")
  fi
  if st=$(stat -c '%U' -- "$CHECKOUT_DIR" 2>/dev/null); then
    owner=$st
  else
    reasons+=("cannot stat $CHECKOUT_DIR")
  fi
  if [ "$owner" != deploy ]; then
    reasons+=("owner is ${owner:-unknown}, expected deploy")
  fi
  if out=$(runuser -u deploy -- git -C "$CHECKOUT_DIR" rev-parse --is-inside-work-tree 2>/dev/null); then
    if [ "$out" != true ]; then
      reasons+=("git work tree check returned ${out:-empty}, expected true")
    fi
  else
    reasons+=("git rev-parse failed as deploy")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list checkout "${reasons[@]}"
  else
    pass "checkout: $CHECKOUT_DIR is a git work tree owned by deploy"
  fi
}

check_tcp_listeners() {
  local out=""
  local state=""
  local local_addr=""
  local port=""
  local tunnel=0
  local bad=()
  local reasons=()
  if ! command -v ss >/dev/null 2>&1; then
    fail_list tcp-listeners "ss is not installed"
    return
  fi
  if ! out=$(ss -H -ltn 2>/dev/null); then
    fail_list tcp-listeners "ss -H -ltn failed"
    return
  fi
  while read -r state _recv _send local_addr _peer; do
    if [ -z "${local_addr:-}" ]; then
      continue
    fi
    port=${local_addr##*:}
    case "$local_addr" in
      127.* | \[::1\]:* | ::1:* | \[::ffff:127.*)
        if [ "$local_addr" = "127.0.0.1:55432" ]; then
          tunnel=1
        fi
        ;;
      *)
        case "$port" in
          22 | 80 | 443) ;;
          *) bad+=("$local_addr") ;;
        esac
        ;;
    esac
  done <<<"$out"
  if [ "${#bad[@]}" -gt 0 ]; then
    reasons+=("unexpected public TCP listener(s): ${bad[*]}")
  fi
  if [ "$tunnel" -ne 1 ]; then
    reasons+=("missing 127.0.0.1:55432 listener")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list tcp-listeners "${reasons[@]}"
  else
    pass "tcp-listeners: public TCP limited to 22, 80, 443 and 127.0.0.1:55432 is present"
  fi
}

check_udp_listeners() {
  local out=""
  local state=""
  local local_addr=""
  local port=""
  local bad=()
  local reasons=()
  if ! command -v ss >/dev/null 2>&1; then
    fail_list udp-listeners "ss is not installed"
    return
  fi
  if ! out=$(ss -H -lun 2>/dev/null); then
    fail_list udp-listeners "ss -H -lun failed"
    return
  fi
  while read -r state _recv _send local_addr _peer; do
    if [ -z "${local_addr:-}" ]; then
      continue
    fi
    port=${local_addr##*:}
    case "$local_addr" in
      127.* | \[::1\]:* | ::1:* | \[::ffff:127.*) ;;
      *)
        case "$port" in
          443 | 68 | 546) ;;
          *) bad+=("$local_addr") ;;
        esac
        ;;
    esac
  done <<<"$out"
  if [ "${#bad[@]}" -gt 0 ]; then
    reasons+=("unexpected public UDP listener(s): ${bad[*]}")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list udp-listeners "${reasons[@]}"
  else
    pass "udp-listeners: public UDP limited to 443, 68, and 546"
  fi
}

check_stack() {
  local compose_file="$CHECKOUT_DIR/deploy/docker-compose.yml"
  local out=""
  local first=""
  local service=""
  local state=""
  local health=""
  local db_ok=0
  local app_ok=0
  local caddy_ok=0
  local reasons=()
  if ! command -v docker >/dev/null 2>&1; then
    fail_list stack "docker is not installed"
    return
  fi
  if [ ! -f "$compose_file" ]; then
    fail_list stack "missing $compose_file"
    return
  fi
  if ! out=$(docker compose -f "$compose_file" ps --format '{{.Service}} {{.State}} {{.Health}}' 2>&1); then
    first=${out%%$'\n'*}
    if [ -n "$first" ]; then
      fail_list stack "docker compose ps failed: $first"
    else
      fail_list stack "docker compose ps failed"
    fi
    return
  fi
  while read -r service state health; do
    case "$service" in
      db)
        if [ "$state" = running ] && [ "$health" = healthy ]; then
          db_ok=1
        fi
        ;;
      app)
        if [ "$state" = running ] && [ "$health" = healthy ]; then
          app_ok=1
        fi
        ;;
      caddy)
        if [ "$state" = running ]; then
          caddy_ok=1
        fi
        ;;
    esac
  done <<<"$out"
  if [ "$db_ok" -ne 1 ]; then
    reasons+=("db is not running healthy")
  fi
  if [ "$app_ok" -ne 1 ]; then
    reasons+=("app is not running healthy")
  fi
  if [ "$caddy_ok" -ne 1 ]; then
    reasons+=("caddy is not running")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list stack "${reasons[@]}"
  else
    pass "stack: db and app are running healthy and caddy is running"
  fi
}

check_https_api() {
  local token=$UI_TOKEN
  local url="https://$DOMAIN/api/projects"
  local status=""
  local rc=0
  if [ -z "$token" ]; then
    # Without a token the authenticated 200 leg cannot run; env-file reports why.
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    fail_list https-api "curl is not installed"
    return
  fi
  status=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $token" -- "$url" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail_list https-api "authenticated request failed (curl exit $rc)"
    return
  fi
  if [ "$status" != 200 ]; then
    fail_list https-api "authenticated request returned ${status:-no status}, expected 200"
    return
  fi
  status=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' -- "$url" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail_list https-api "unauthenticated request failed (curl exit $rc)"
    return
  fi
  if [ "$status" != 401 ]; then
    fail_list https-api "unauthenticated request returned ${status:-no status}, expected 401"
    return
  fi
  pass "https-api: $url returns 200 with the token and 401 without it"
}

check_webhook() {
  local compose_file="$CHECKOUT_DIR/deploy/docker-compose.yml"
  local body='{"action":"opened","number":0,"pull_request":{"number":0,"title":"ZZZ-999999 verify","merged":false,"head":{"ref":"ZZZ-999999-verify"}}}'
  local sig=""
  local status=""
  local url="https://$DOMAIN/webhooks/github"
  read_env GITHUB_WEBHOOK_SECRET >/dev/null || return
  if ! command -v curl >/dev/null 2>&1; then
    fail_list webhook "curl is not installed"
    return
  fi
  # The HMAC is computed inside the app container so the secret never reaches
  # host argv or output.
  sig=$(printf '%s' "$body" | docker compose -f "$compose_file" exec -T app node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const c=require("node:crypto");process.stdout.write("sha256="+c.createHmac("sha256",process.env.GITHUB_WEBHOOK_SECRET).update(d,"utf8").digest("hex"))})' 2>/dev/null) || sig=""
  if [ -z "$sig" ]; then
    fail_list webhook "the app container produced no signature (is GITHUB_WEBHOOK_SECRET set in the app env?)"
    return
  fi
  status=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H 'x-github-event: pull_request' \
    --data-binary "$body" -- "$url" 2>/dev/null)
  if [ "$status" != 401 ]; then
    fail_list webhook "unsigned delivery returned ${status:-no status}, expected 401"
    return
  fi
  status=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H 'x-github-event: pull_request' \
    -H "x-hub-signature-256: $sig" \
    --data-binary "$body" -- "$url" 2>/dev/null)
  if [ "$status" != 200 ]; then
    fail_list webhook "signed delivery returned ${status:-no status} and body is not the ignored acknowledgement, expected 200"
    return
  fi
  pass "webhook: unsigned delivery is 401 and a correctly signed unknown-key delivery is ignored with 200"
}

check_tls_certificate() {
  local token=$UI_TOKEN
  local url="https://$DOMAIN/api/projects"
  local out=""
  local rc=0
  local verify=""
  local status=""
  local issuer=""
  local reasons=()
  if [ -z "$token" ]; then
    # Without a token the authenticated leg cannot run; env-file reports why.
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    fail_list tls-certificate "curl is not installed"
    return
  fi
  out=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -o /dev/null -w '%{ssl_verify_result} %{http_code}' \
    -H "Authorization: Bearer $token" -- "$url" 2>/dev/null)
  rc=$?
  read -r verify status <<<"$out"
  if [ "$rc" -ne 0 ]; then
    reasons+=("HTTPS request failed (curl exit $rc)")
  fi
  if [ -z "${status:-}" ]; then
    reasons+=("HTTPS request returned no status")
  elif [ "$status" != 200 ]; then
    reasons+=("HTTPS request returned $status, expected 200")
  fi
  if [ "$PUBLIC_TLS" -eq 1 ]; then
    if [ "${verify:-}" != 0 ]; then
      reasons+=("certificate did not verify (ssl_verify_result ${verify:-none}, expected 0)")
    fi
    if ! command -v openssl >/dev/null 2>&1; then
      reasons+=("openssl is not installed")
    else
      # Same resolve as the curl probe: loopback address, SNI for the domain.
      issuer=$(printf '' | openssl s_client -connect 127.0.0.1:443 \
        -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
      case "$issuer" in
        "") reasons+=("cannot read the leaf issuer over 127.0.0.1:443") ;;
        *"Caddy Local Authority"*) reasons+=("leaf issuer is Caddy Local Authority, expected a public CA") ;;
      esac
    fi
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list tls-certificate "${reasons[@]}"
  elif [ "$PUBLIC_TLS" -eq 1 ]; then
    pass "tls-certificate: $url returns 200 with a publicly trusted certificate"
  else
    pass "tls-certificate: $url returns 200 over HTTPS with the internal CA"
  fi
}

check_http_redirect() {
  local url="http://$DOMAIN/"
  local out=""
  local rc=0
  local status=""
  local location=""
  local reasons=()
  if ! command -v curl >/dev/null 2>&1; then
    fail_list http-redirect "curl is not installed"
    return
  fi
  out=$(curl -sS --max-time 10 --resolve "$DOMAIN:80:127.0.0.1" \
    -o /dev/null -w '%{http_code} %{redirect_url}' -- "$url" 2>/dev/null)
  rc=$?
  read -r status location <<<"$out"
  if [ "$rc" -ne 0 ]; then
    reasons+=("plain HTTP request failed (curl exit $rc)")
  fi
  case "${status:-}" in
    301 | 302 | 307 | 308) ;;
    *) reasons+=("plain HTTP returned ${status:-no status}, expected a 3xx redirect") ;;
  esac
  case "${location:-}" in
    https://*) ;;
    *) reasons+=("redirect target is ${location:-empty}, expected an https:// URL") ;;
  esac
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list http-redirect "${reasons[@]}"
  else
    pass "http-redirect: $url returns a 3xx redirect to $location"
  fi
}

check_hsts() {
  local url="https://$DOMAIN/"
  local headers=""
  local header=""
  local age=""
  local rc=0
  local reasons=()
  if ! command -v curl >/dev/null 2>&1; then
    fail_list hsts "curl is not installed"
    return
  fi
  headers=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -D - -o /dev/null -- "$url" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail_list hsts "HTTPS request failed (curl exit $rc)"
    return
  fi
  header=$(printf '%s\n' "$headers" | grep -i '^strict-transport-security:' | head -n 1 || true)
  age=$(printf '%s\n' "$header" | grep -oiE 'max-age=[0-9]+' | head -n 1 | cut -d= -f2 || true)
  if [ "$PUBLIC_TLS" -eq 1 ]; then
    if [ -z "$header" ]; then
      reasons+=("no Strict-Transport-Security header")
    elif [ -z "$age" ]; then
      reasons+=("Strict-Transport-Security has no max-age")
    elif [ "$age" -lt 31536000 ]; then
      reasons+=("Strict-Transport-Security max-age is $age, expected at least 31536000")
    fi
  elif [ -n "$header" ]; then
    reasons+=("Strict-Transport-Security is present for a non-public deployment")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list hsts "${reasons[@]}"
  elif [ "$PUBLIC_TLS" -eq 1 ]; then
    pass "hsts: $url sends Strict-Transport-Security max-age=$age"
  else
    pass "hsts: $url sends no Strict-Transport-Security header"
  fi
}

check_compression() {
  local url="https://$DOMAIN/"
  local asset_url=""
  local asset=""
  local body=""
  local headers=""
  local encoding=""
  local rc=0
  if ! command -v curl >/dev/null 2>&1; then
    fail_list compression "curl is not installed"
    return
  fi
  headers=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -H 'Accept-Encoding: gzip' -D - -o /dev/null -- "$url" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail_list compression "HTTPS request failed (curl exit $rc)"
    return
  fi
  encoding=$(encoding_of "$headers")
  if [ -n "$encoding" ]; then
    pass "compression: $url returns content-encoding $encoding"
    return
  fi
  # Caddy skips bodies under 512 bytes, so probe the first asset build output.
  body=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -H 'Accept-Encoding: gzip' -- "$url" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail_list compression "HTTPS request for the shell failed (curl exit $rc)"
    return
  fi
  asset=$(printf '%s' "$body" | grep -oE 'src="/assets/[^"]+"' | head -n 1 || true)
  asset=${asset#src=\"}
  asset=${asset%\"}
  if [ -z "$asset" ]; then
    fail_list compression "no content-encoding on $url and no /assets/ script in the shell"
    return
  fi
  asset_url="https://$DOMAIN$asset"
  headers=$(curl_tls --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
    -H 'Accept-Encoding: gzip' -D - -o /dev/null -- "$asset_url" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail_list compression "HTTPS request for $asset failed (curl exit $rc)"
    return
  fi
  encoding=$(encoding_of "$headers")
  if [ -z "$encoding" ]; then
    fail_list compression "$asset_url returns no gzip or zstd content-encoding"
    return
  fi
  pass "compression: $asset_url returns content-encoding $encoding"
}

check_caddy_issuance() {
  local compose_file="$CHECKOUT_DIR/deploy/docker-compose.yml"
  local out=""
  local first=""
  local reasons=()
  if ! command -v docker >/dev/null 2>&1; then
    fail_list caddy-issuance "docker is not installed"
    return
  fi
  if [ ! -f "$compose_file" ]; then
    fail_list caddy-issuance "missing $compose_file"
    return
  fi
  if ! out=$(docker compose -f "$compose_file" logs --tail=2000 caddy 2>&1); then
    first=${out%%$'\n'*}
    if [ -n "$first" ]; then
      fail_list caddy-issuance "docker compose logs failed: $first"
    else
      fail_list caddy-issuance "docker compose logs failed"
    fi
    return
  fi
  if ! grep -Fq 'certificate obtained successfully' <<<"$out"; then
    reasons+=("log has no 'certificate obtained successfully'")
  fi
  if ! grep -Fq -- "$DOMAIN" <<<"$out"; then
    reasons+=("log does not mention $DOMAIN")
  fi
  if [ "$PUBLIC_TLS" -eq 1 ] && ! grep -Eqi 'letsencrypt|acme' <<<"$out"; then
    reasons+=("log has no Let's Encrypt or ACME issuer marker")
  fi
  if [ "${#reasons[@]}" -gt 0 ]; then
    fail_list caddy-issuance "${reasons[@]}"
  elif [ "$PUBLIC_TLS" -eq 1 ]; then
    pass "caddy-issuance: caddy logged an ACME certificate obtained for $DOMAIN"
  else
    pass "caddy-issuance: caddy logged a certificate obtained for $DOMAIN"
  fi
}

check_os
check_deploy_user
check_ssh_dir
check_authorized_keys
check_sshd
check_data_mount
check_storage
check_docker_root
check_docker_config
check_docker_mount_dependency
check_docker_prune_timer
check_keepalive_timer
check_backup_dir
check_backup_timer
check_backup_freshness
check_backup_integrity
check_env_file
check_checkout
check_tcp_listeners
check_udp_listeners
if [ "$SKIP_STACK" -eq 0 ]; then
  check_stack
  check_tls_certificate
  check_http_redirect
  check_hsts
  check_compression
  check_caddy_issuance
  check_https_api
  check_webhook
fi

if [ "$FAILED" -eq 0 ]; then
  printf 'verify-host: ok\n'
  exit 0
fi
printf 'verify-host: FAIL (%s)\n' "$FAILED"
exit 1
