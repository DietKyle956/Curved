#!/usr/bin/env bash
# Idempotent host bootstrap for the curved production stack on Ubuntu 24.04.
# Run as root from the repository root:
#   sudo bash deploy/bootstrap-host.sh --key ~/.ssh/id_ed25519.pub
set -euo pipefail

MOUNT_DIR=/srv/curved
CHECKOUT_DIR=
REPO_URL=https://github.com/DietKyle956/Curved.git
DOMAIN=localhost
DATA_DEVICE=
WANT_STACK=1
KEY_FILES=()

usage() {
  cat <<'EOF'
Usage: sudo bash deploy/bootstrap-host.sh [options]

Prepare an Ubuntu 24.04 host to run the curved production stack: install Docker,
mount the 100 GiB data volume with an fstab entry, create the key-only deploy
user, harden sshd, clone the repository, generate deploy/.env once, and start
the stack. Every step is safe to re-run.

Options:
  --key FILE          Authorized public key for the deploy user (repeatable)
  --data-device DEV   Block device for the data volume (default: auto-detect)
  --mount-dir DIR     Mount point for the data volume (default: /srv/curved)
  --checkout-dir DIR  Repository checkout (default: <mount-dir>/checkout)
  --repo-url URL      Repository to clone
                      (default: https://github.com/DietKyle956/Curved.git)
  --domain NAME       Hostname Caddy serves (default: localhost)
  --no-stack          Skip starting the production compose stack
  -h, --help          Show this help

Exit codes: 0 on success, 1 on a failed check, 2 on invalid arguments.
EOF
}

die() {
  printf 'bootstrap-host: %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf 'bootstrap-host: %s\n\n' "$*" >&2
  usage >&2
  exit 2
}

pass() {
  printf 'PASS %s\n' "$*"
}

require_command() {
  local cmd=$1 hint=${2:-}
  if ! command -v "$cmd" >/dev/null 2>&1; then
    if [ -n "$hint" ]; then
      die "required command '$cmd' not found (install $hint)"
    fi
    die "required command '$cmd' not found"
  fi
}

single_quote() {
  printf "%s" "${1//\'/\'\\\'\'}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --key)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage_error "--key requires a file argument"
      fi
      KEY_FILES+=("$2")
      shift 2
      ;;
    --data-device)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage_error "--data-device requires a device argument"
      fi
      DATA_DEVICE=$2
      shift 2
      ;;
    --mount-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage_error "--mount-dir requires a directory argument"
      fi
      MOUNT_DIR=$2
      shift 2
      ;;
    --checkout-dir)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage_error "--checkout-dir requires a directory argument"
      fi
      CHECKOUT_DIR=$2
      shift 2
      ;;
    --repo-url)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage_error "--repo-url requires a URL argument"
      fi
      REPO_URL=$2
      shift 2
      ;;
    --domain)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage_error "--domain requires a hostname argument"
      fi
      DOMAIN=$2
      shift 2
      ;;
    --no-stack)
      WANT_STACK=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage_error "unknown argument: $1"
      ;;
  esac
done

MOUNT_DIR=${MOUNT_DIR%/}
if [ -z "$MOUNT_DIR" ]; then
  MOUNT_DIR=/
fi
CHECKOUT_DIR=${CHECKOUT_DIR:-"$MOUNT_DIR/checkout"}
CHECKOUT_DIR=${CHECKOUT_DIR%/}
if [ -z "$CHECKOUT_DIR" ]; then
  CHECKOUT_DIR=/
fi

case "$MOUNT_DIR" in
  /*) ;;
  *) usage_error "--mount-dir must be an absolute path" ;;
esac
case "$CHECKOUT_DIR" in
  /*) ;;
  *) usage_error "--checkout-dir must be an absolute path" ;;
esac
if [ "$MOUNT_DIR" = / ]; then
  usage_error "--mount-dir must not be /"
fi
if [ "$CHECKOUT_DIR" = / ]; then
  usage_error "--checkout-dir must not be /"
fi
if [ "$MOUNT_DIR" = "$CHECKOUT_DIR" ]; then
  usage_error "--mount-dir and --checkout-dir must differ"
fi
case "$DOMAIN" in
  *[[:space:]]*) usage_error "--domain must not contain whitespace" ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  die "must run as root (sudo bash deploy/bootstrap-host.sh)"
fi
pass "root"

if [ ! -r /etc/os-release ]; then
  die "cannot read /etc/os-release"
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  die "requires Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
fi
pass "os (Ubuntu 24.04)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git iproute2 openssl util-linux e2fsprogs passwd
apt-get install -y docker.io

if ! docker compose version >/dev/null 2>&1; then
  if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
    apt-get install -y docker-compose-v2
  else
    # Ubuntu has no compose v2 package here; take the plugin from Docker's repo.
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
    docker_arch=$(dpkg --print-architecture)
    docker_codename=${VERSION_CODENAME:-}
    if [ -z "$docker_codename" ]; then
      die "VERSION_CODENAME missing from /etc/os-release"
    fi
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$docker_arch" "$docker_codename" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-compose-plugin
  fi
fi

require_command docker docker.io
if ! docker compose version >/dev/null 2>&1; then
  die "docker compose is not available after installation"
fi
require_command systemctl
require_command blkid util-linux
require_command blockdev util-linux
require_command lsblk util-linux
require_command findmnt util-linux
require_command mountpoint util-linux
require_command mount util-linux
require_command mkfs.ext4 e2fsprogs
require_command runuser util-linux
require_command useradd passwd
require_command usermod passwd
require_command sshd openssh-server

systemctl enable --now docker
pass "packages (docker, compose, base tools)"

size_min=$((90 * 1024 * 1024 * 1024))
size_max=$((110 * 1024 * 1024 * 1024))

device_disk() {
  local name
  name=$(lsblk -s -r -n -o NAME,TYPE -- "$1" 2>/dev/null |
    awk '$2 == "disk" { print $1; exit }') || true
  printf '%s' "$name"
}

device_mounts() {
  lsblk -r -n -o MOUNTPOINT -- "$1" 2>/dev/null | awk 'NF'
}

root_source=$(findmnt -n -o SOURCE --target / 2>/dev/null || true)
if [ -z "$root_source" ]; then
  die "cannot determine the root filesystem source"
fi
root_source=${root_source%%\[*}
root_disk=$(device_disk "$root_source")
if [ -z "$root_disk" ]; then
  die "cannot determine the root disk from $root_source"
fi

if [ -n "$DATA_DEVICE" ]; then
  data_dev=$DATA_DEVICE
elif mountpoint -q "$MOUNT_DIR"; then
  # A re-run finds the volume already mounted; reuse its source device.
  data_dev=$(findmnt -n -o SOURCE --target "$MOUNT_DIR")
  data_dev=${data_dev%%\[*}
else
  candidates=()
  while read -r disk_name disk_type; do
    if [ "$disk_type" != disk ]; then
      continue
    fi
    if [ "$disk_name" = "$root_disk" ]; then
      continue
    fi
    candidate="/dev/$disk_name"
    if [ -n "$(device_mounts "$candidate")" ]; then
      continue
    fi
    candidate_bytes=$(blockdev --getsize64 "$candidate" 2>/dev/null || true)
    if [ -z "$candidate_bytes" ]; then
      continue
    fi
    if [ "$candidate_bytes" -ge "$size_min" ] && [ "$candidate_bytes" -le "$size_max" ]; then
      candidates+=("$candidate")
    fi
  done < <(lsblk -d -r -n -o NAME,TYPE)

  if [ "${#candidates[@]}" -eq 0 ]; then
    die "no unmounted 90-110 GiB data disk found; pass --data-device DEV"
  fi
  if [ "${#candidates[@]}" -gt 1 ]; then
    die "multiple candidate data disks (${candidates[*]}); pass --data-device DEV"
  fi
  data_dev=${candidates[0]}
fi

if [ ! -b "$data_dev" ]; then
  die "data device $data_dev is not a block device"
fi
data_disk=$(device_disk "$data_dev")
if [ -z "$data_disk" ]; then
  die "cannot determine the disk backing $data_dev"
fi
if [ "$data_disk" = "$root_disk" ]; then
  die "refusing to use $data_dev: it is (or is on) the root disk $root_disk"
fi

data_bytes=$(blockdev --getsize64 "$data_dev")
if [ "$data_bytes" -lt "$size_min" ] || [ "$data_bytes" -gt "$size_max" ]; then
  die "data device $data_dev is $((data_bytes / 1073741824)) GiB; expected 90-110 GiB"
fi

data_mounts=$(device_mounts "$data_dev")
if [ -n "$data_mounts" ] && [ "$data_mounts" != "$MOUNT_DIR" ]; then
  die "data device $data_dev is already mounted at $(printf '%s' "$data_mounts" | tr '\n' ' ')"
fi

data_types=$(lsblk -r -n -o TYPE -- "$data_dev")
data_type=$(printf '%s\n' "$data_types" | head -n 1)
if [ "$data_type" != part ] && printf '%s\n' "$data_types" | grep -qx part; then
  die "$data_dev is a whole disk with partition children; pass the intended blank volume with --data-device"
fi

pass "data-device ($data_dev)"

mkdir -p "$MOUNT_DIR"

if mountpoint -q "$MOUNT_DIR"; then
  mounted_source=$(findmnt -n -o SOURCE --target "$MOUNT_DIR")
  mounted_source=${mounted_source%%\[*}
  mounted_uuid=$(blkid -p -s UUID -o value -- "$mounted_source" 2>/dev/null || true)
  data_uuid=$(blkid -p -s UUID -o value -- "$data_dev" 2>/dev/null || true)
  source_real=$(realpath "$mounted_source" 2>/dev/null || true)
  data_real=$(realpath "$data_dev" 2>/dev/null || true)
  if [ "$source_real" != "$data_real" ] &&
    { [ -z "$data_uuid" ] || [ "$mounted_uuid" != "$data_uuid" ]; }; then
    die "$MOUNT_DIR is mounted from $mounted_source, expected $data_dev"
  fi
else
  fs_type=$(blkid -p -o value -s TYPE -- "$data_dev" 2>/dev/null || true)
  if [ -z "$fs_type" ]; then
    mkfs.ext4 -F -L curved-data "$data_dev"
  elif [ "$fs_type" != ext4 ]; then
    die "$data_dev already has a $fs_type filesystem; expected ext4"
  fi
  mount "$data_dev" "$MOUNT_DIR"
fi

data_uuid=$(blkid -p -s UUID -o value -- "$data_dev" 2>/dev/null || true)
if [ -z "$data_uuid" ]; then
  die "cannot read the filesystem UUID of $data_dev"
fi

if ! awk -v uuid="UUID=$data_uuid" '$1 == uuid { found = 1 } END { exit found ? 0 : 1 }' /etc/fstab; then
  fstab_source=$(awk -v mnt="$MOUNT_DIR" '$2 == mnt { print $1 }' /etc/fstab)
  if [ -n "$fstab_source" ]; then
    die "/etc/fstab already mounts $MOUNT_DIR from $fstab_source"
  fi
  if [ -s /etc/fstab ] && [ "$(tail -c 1 /etc/fstab)" != "" ]; then
    printf '\n' >> /etc/fstab
  fi
  printf 'UUID=%s %s ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2\n' \
    "$data_uuid" "$MOUNT_DIR" >> /etc/fstab
fi
pass "filesystem ($data_dev at $MOUNT_DIR)"

if ! id -u deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
if ! getent group docker >/dev/null 2>&1; then
  die "the docker group does not exist; docker.io installation did not complete"
fi
usermod -aG docker deploy

ssh_dir=/home/deploy/.ssh
auth_file=$ssh_dir/authorized_keys
install -d -m 0700 -o deploy -g deploy "$ssh_dir"
chown deploy:deploy "$ssh_dir"
chmod 0700 "$ssh_dir"
if [ ! -e "$auth_file" ]; then
  install -m 0600 -o deploy -g deploy /dev/null "$auth_file"
fi
for key_file in "${KEY_FILES[@]}"; do
  if [ ! -f "$key_file" ] || [ ! -r "$key_file" ]; then
    die "--key $key_file is not a readable file"
  fi
  while IFS= read -r key_line || [ -n "$key_line" ]; do
    key_line=${key_line%$'\r'}
    case "$key_line" in
      ''|'#'*) continue ;;
      ssh-*|ecdsa-*|sk-*) ;;
      *) die "--key $key_file has a line that is not an OpenSSH public key: ${key_line%% *}" ;;
    esac
    if grep -Fxq -e "$key_line" "$auth_file"; then
      continue
    fi
    printf '%s\n' "$key_line" >> "$auth_file"
  done < "$key_file"
done
chown deploy:deploy "$auth_file"
chmod 0600 "$auth_file"
if ! awk 'NF && $1 !~ /^#/ { found = 1 } END { exit found ? 0 : 1 }' "$auth_file"; then
  die "deploy has no SSH keys; pass --key FILE at least once"
fi
pass "deploy-user (docker group, key-only SSH)"

sshd_conf_dir=/etc/ssh/sshd_config.d
sshd_conf=$sshd_conf_dir/00-curved-access.conf
mkdir -p "$sshd_conf_dir"
desired_sshd=$(printf '%s\n' \
  'PubkeyAuthentication yes' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'PermitRootLogin no' \
  'AllowUsers ubuntu deploy')
current_sshd=
if [ -f "$sshd_conf" ]; then
  current_sshd=$(cat "$sshd_conf")
fi

if [ "$current_sshd" = "$desired_sshd" ]; then
  pass "sshd (unchanged)"
else
  sshd_backup=
  if [ -f "$sshd_conf" ]; then
    sshd_backup=$(mktemp "$sshd_conf_dir/.00-curved-access.XXXXXX")
    cp -a "$sshd_conf" "$sshd_backup"
  fi
  sshd_tmp=$(mktemp "$sshd_conf_dir/.00-curved-access.XXXXXX")
  printf '%s\n' "$desired_sshd" > "$sshd_tmp"
  chmod 0644 "$sshd_tmp"
  mv "$sshd_tmp" "$sshd_conf"
  if ! sshd -t; then
    if [ -n "$sshd_backup" ]; then
      cp -a "$sshd_backup" "$sshd_conf"
    else
      rm -f "$sshd_conf"
    fi
    if [ -n "$sshd_backup" ]; then
      rm -f "$sshd_backup"
    fi
    die "sshd rejected the access configuration; restored the previous state"
  fi
  if [ -n "$sshd_backup" ]; then
    rm -f "$sshd_backup"
  fi
  systemctl reload ssh
  pass "sshd (access policy applied)"
fi

chown deploy:deploy "$MOUNT_DIR"
chmod 0755 "$MOUNT_DIR"

if [ ! -e "$CHECKOUT_DIR/.git" ]; then
  if [ -e "$CHECKOUT_DIR" ] && [ ! -d "$CHECKOUT_DIR" ]; then
    die "$CHECKOUT_DIR exists and is not a directory"
  fi
  if [ -d "$CHECKOUT_DIR" ] && [ -n "$(ls -A "$CHECKOUT_DIR")" ]; then
    die "$CHECKOUT_DIR is not empty and is not a git checkout"
  fi
  if [ -d "$CHECKOUT_DIR" ]; then
    chown deploy:deploy "$CHECKOUT_DIR"
  fi
  # runuser keeps root's HOME, which deploy cannot read; use the deploy home
  # so git reads (or creates) its global config as deploy.
  runuser -u deploy -- env HOME=/home/deploy git clone "$REPO_URL" "$CHECKOUT_DIR"
fi
chown -R deploy:deploy "$CHECKOUT_DIR"
pass "checkout ($CHECKOUT_DIR)"

env_example=$CHECKOUT_DIR/deploy/.env.example
env_file=$CHECKOUT_DIR/deploy/.env
if [ ! -f "$env_example" ]; then
  die "missing $env_example; is $REPO_URL the curved repository?"
fi

if [ ! -e "$env_file" ]; then
  db_password=$(openssl rand -hex 24)
  ui_token=$(openssl rand -hex 32)
  webhook_secret=$(openssl rand -hex 32)
  env_tmp=$(mktemp "${env_file}.XXXXXX")
  {
    printf 'POSTGRES_USER=curved\n'
    printf 'POSTGRES_PASSWORD=%s\n' "$db_password"
    printf 'POSTGRES_DB=curved\n'
    printf 'CURVED_UI_TOKEN=%s\n' "$ui_token"
    printf 'GITHUB_WEBHOOK_SECRET=%s\n' "$webhook_secret"
    printf 'CURVED_DOMAIN=%s\n' "$DOMAIN"
    printf 'ACME_EMAIL=\n'
    printf 'COOKIE_SECURE=1\n'
  } > "$env_tmp"
  chown deploy:deploy "$env_tmp"
  chmod 0600 "$env_tmp"
  mv "$env_tmp" "$env_file"
else
  if grep -q 'change-me' "$env_file"; then
    die "$env_file still contains change-me placeholders; set real values or remove it"
  fi
fi
chown deploy:deploy "$env_file"
chmod 0600 "$env_file"
pass "environment ($env_file)"

if [ "$WANT_STACK" -eq 1 ]; then
  if [ ! -f "$CHECKOUT_DIR/deploy/docker-compose.yml" ]; then
    die "missing $CHECKOUT_DIR/deploy/docker-compose.yml"
  fi
  # runuser keeps root's HOME; the docker CLI skips plugin discovery it cannot
  # read, so point it at the deploy home to find the compose plugin.
  runuser -u deploy -- env HOME=/home/deploy bash -c \
    "cd '$(single_quote "$CHECKOUT_DIR")' && docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 900"
  pass "stack"
fi

printf 'bootstrap-host: ok\n'
