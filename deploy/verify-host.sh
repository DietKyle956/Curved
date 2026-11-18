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
  --skip-stack        Skip the Docker Compose and HTTPS API checks.
  -h, --help          Show this message and exit.

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
ENV_FILE="$CHECKOUT_DIR/deploy/.env"

if [ "$DOMAIN_GIVEN" -eq 0 ]; then
  DOMAIN=$(read_env CURVED_DOMAIN || true)
  if [ -z "$DOMAIN" ]; then
    DOMAIN="localhost"
  fi
fi
UI_TOKEN=$(read_env CURVED_UI_TOKEN || true)

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
          443 | 68) ;;
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
    pass "udp-listeners: public UDP limited to 443 and 68"
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
  status=$(curl -ksS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
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
  status=$(curl -ksS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" \
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

check_os
check_deploy_user
check_ssh_dir
check_authorized_keys
check_sshd
check_data_mount
check_storage
check_env_file
check_checkout
check_tcp_listeners
check_udp_listeners
if [ "$SKIP_STACK" -eq 0 ]; then
  check_stack
  check_https_api
fi

if [ "$FAILED" -eq 0 ]; then
  printf 'verify-host: ok\n'
  exit 0
fi
printf 'verify-host: FAIL (%s)\n' "$FAILED"
exit 1
