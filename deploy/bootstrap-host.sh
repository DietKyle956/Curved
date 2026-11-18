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
mount the 100 GiB data volume with an fstab entry, move Docker's data root onto
that volume, create the key-only deploy user, harden sshd, clone the
repository, generate deploy/.env once, and start the stack. Docker images,
containers and build cache live on the data volume (<mount-dir>/docker), so a
host rebuild does not re-download the stack. Every step is safe to re-run.

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

# write_if_changed PATH MODE CONTENT
# Replace PATH only when its content differs, printing "changed" or
# "unchanged". The file is swapped in atomically, so re-runs leave it alone.
write_if_changed() {
  local path=$1 mode=$2 content=$3
  local dir tmp current=
  dir=$(dirname "$path")
  install -d -m 0755 "$dir"
  if [ -f "$path" ]; then
    current=$(cat "$path")
  fi
  if [ "$current" = "$content" ]; then
    printf 'unchanged'
    return 0
  fi
  tmp=$(mktemp "$dir/.$(basename "$path").XXXXXX")
  printf '%s\n' "$content" > "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$path"
  printf 'changed'
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
DOCKER_DATA_DIR=$MOUNT_DIR/docker
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

# Docker keeps images, containers and build cache on the data volume so a host
# rebuild never re-downloads the stack. This runs after the mount step and
# before the daemon may start: the drop-in below makes docker.service wait for
# the mount, and nothing earlier enables or starts docker.
mkdir -p "$DOCKER_DATA_DIR"
chown root:root "$DOCKER_DATA_DIR"
chmod 0710 "$DOCKER_DATA_DIR"

docker_daemon_json=/etc/docker/daemon.json
docker_daemon_backup=/etc/docker/daemon.json.pre-curved
docker_old_root=/var/lib/docker
docker_unit_dir=/etc/systemd/system
docker_dropin_dir=$docker_unit_dir/docker.service.d
docker_dropin=$docker_dropin_dir/10-curved-data-root.conf
docker_prune_service=$docker_unit_dir/curved-docker-prune.service
docker_prune_timer=$docker_unit_dir/curved-docker-prune.timer
docker_bin=$(command -v docker)

docker_current_root=
if [ -f "$docker_daemon_json" ]; then
  docker_current_root=$(sed -n \
    's/^[[:space:]]*"data-root"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' \
    "$docker_daemon_json" | head -n 1) || true
fi
if [ -z "$docker_current_root" ]; then
  docker_current_root=$docker_old_root
fi

# Migrate the existing rootfs once: only when docker still runs on the old
# default, that directory holds data, and the target has no image store yet.
docker_migrated=0
docker_socket_was_active=0
if [ "$docker_current_root" = "$docker_old_root" ] &&
  [ "$(realpath -m "$DOCKER_DATA_DIR")" != "$(realpath -m "$docker_old_root")" ] &&
  [ -d "$docker_old_root" ] &&
  [ -n "$(ls -A "$docker_old_root" 2>/dev/null || true)" ] &&
  [ ! -e "$DOCKER_DATA_DIR/image" ]; then
  # Stop the socket first so nothing can socket-activate the daemon mid-copy.
  if systemctl is-active --quiet docker.socket; then
    docker_socket_was_active=1
    systemctl stop docker.socket
  fi
  if systemctl is-active --quiet docker; then
    systemctl stop docker
  fi
  cp -a /var/lib/docker/. "$DOCKER_DATA_DIR"/
  # cp -a copies the source directory's mode onto the target; reassert the
  # managed 0710 root:root after a migration.
  chown root:root "$DOCKER_DATA_DIR"
  chmod 0710 "$DOCKER_DATA_DIR"
  docker_migrated=1
fi

desired_daemon_json=$(
  printf '{\n'
  printf '  "data-root": "%s",\n' "$DOCKER_DATA_DIR"
  printf '  "log-driver": "json-file",\n'
  printf '  "log-opts": {\n'
  printf '    "max-size": "10m",\n'
  printf '    "max-file": "3"\n'
  printf '  },\n'
  printf '  "builder": {\n'
  printf '    "gc": {\n'
  printf '      "enabled": true,\n'
  printf '      "defaultKeepStorage": "5GB"\n'
  printf '    }\n'
  printf '  }\n'
  printf '}\n'
)
current_daemon_json=
if [ -f "$docker_daemon_json" ]; then
  current_daemon_json=$(cat "$docker_daemon_json")
fi
docker_json_changed=0
if [ "$current_daemon_json" != "$desired_daemon_json" ]; then
  if [ -e "$docker_daemon_json" ] && [ ! -e "$docker_daemon_backup" ]; then
    cp -a "$docker_daemon_json" "$docker_daemon_backup"
  fi
  write_if_changed "$docker_daemon_json" 0644 "$desired_daemon_json" >/dev/null
  docker_json_changed=1
fi

desired_dropin=$(
  printf '[Unit]\n'
  printf 'RequiresMountsFor=%s\n' "$DOCKER_DATA_DIR"
  printf 'ConditionPathIsMountPoint=%s\n' "$MOUNT_DIR"
)
docker_dropin_changed=0
if [ "$(write_if_changed "$docker_dropin" 0644 "$desired_dropin")" = changed ]; then
  docker_dropin_changed=1
fi

desired_prune_service=$(
  printf '[Unit]\n'
  printf 'Description=Prune unused Curved Docker build cache and images\n'
  printf 'Requires=docker.service\n'
  printf 'After=docker.service\n'
  printf '\n'
  printf '[Service]\n'
  printf 'Type=oneshot\n'
  printf 'ExecStart=%s builder prune -af --filter until=168h\n' "$docker_bin"
  printf 'ExecStart=%s image prune -f --filter until=720h\n' "$docker_bin"
)
write_if_changed "$docker_prune_service" 0644 "$desired_prune_service" >/dev/null

desired_prune_timer=$(
  printf '[Unit]\n'
  printf 'Description=Daily prune of unused Curved Docker build cache and images\n'
  printf '\n'
  printf '[Timer]\n'
  printf 'OnCalendar=*-*-* 04:37:00\n'
  printf 'RandomizedDelaySec=15m\n'
  printf 'Persistent=true\n'
  printf '\n'
  printf '[Install]\n'
  printf 'WantedBy=timers.target\n'
)
write_if_changed "$docker_prune_timer" 0644 "$desired_prune_timer" >/dev/null

systemctl daemon-reload
systemctl enable docker
if [ "$docker_json_changed" -eq 1 ] || [ "$docker_dropin_changed" -eq 1 ] ||
  [ "$docker_migrated" -eq 1 ]; then
  systemctl restart docker
elif ! systemctl is-active --quiet docker; then
  systemctl start docker
fi
if [ "$docker_socket_was_active" -eq 1 ] && ! systemctl is-active --quiet docker.socket; then
  systemctl start docker.socket
fi

systemctl enable curved-docker-prune.timer
systemctl start curved-docker-prune.timer

docker_live_root=
docker_wait=0
while [ -z "$docker_live_root" ] && [ "$docker_wait" -lt 30 ]; do
  docker_live_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -z "$docker_live_root" ]; then
    docker_wait=$((docker_wait + 1))
    sleep 1
  fi
done
if [ -z "$docker_live_root" ]; then
  die "docker did not become ready within 30s; check journalctl -u docker"
fi
docker_expected_root=$(realpath -m "$DOCKER_DATA_DIR")
if [ "$(realpath -m "$docker_live_root")" != "$docker_expected_root" ]; then
  die "docker uses $docker_live_root as its data root, expected $docker_expected_root; check $docker_daemon_json"
fi

if [ "$docker_migrated" -eq 1 ]; then
  pass "docker-data ($DOCKER_DATA_DIR)"
else
  pass "docker-data (unchanged)"
fi
if [ "$docker_json_changed" -eq 1 ]; then
  pass "docker-config (data-root $DOCKER_DATA_DIR)"
else
  pass "docker-config (unchanged)"
fi
if [ "$docker_dropin_changed" -eq 1 ]; then
  pass "docker-mount-dependency (docker.service requires $MOUNT_DIR)"
else
  pass "docker-mount-dependency (unchanged)"
fi
pass "docker-prune-timer (daily build cache and image prune)"

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
  compose_command="docker compose -f deploy/docker-compose.yml up -d --build --wait --wait-timeout 900"
  if [ "$docker_json_changed" -eq 1 ]; then
    # Daemon logging defaults only reach new containers, so recreate the stack
    # once when daemon.json changes (for example the LAS-184 upgrade).
    compose_command="$compose_command --force-recreate"
  fi
  runuser -u deploy -- env HOME=/home/deploy bash -c \
    "cd '$(single_quote "$CHECKOUT_DIR")' && $compose_command"
  pass "stack"
fi

printf 'bootstrap-host: ok\n'
