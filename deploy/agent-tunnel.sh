#!/usr/bin/env bash
# Open the SSH tunnel agents use to reach the deployed Curved Postgres.
#
# The production database binds only to 127.0.0.1:55432 on the host, so an
# agent cannot connect to it directly. This script forwards the conventional
# local port 55433 to that loopback listener over SSH. Local development owns
# 55432, so that port is refused to keep the two from colliding.
#
# Usage:
#   deploy/agent-tunnel.sh --host HOST [options]
#
# Environment:
#   CURVED_DEPLOY_HOST        Host to tunnel to (required).
#   CURVED_DEPLOY_USER        SSH user (default deploy).
#   CURVED_SSH_IDENTITY       Private key passed with -i.
#   CURVED_SSH_KNOWN_HOSTS    known_hosts file passed as -o
#                             UserKnownHostsFile.
#   CURVED_TUNNEL_LOCAL_PORT  Local forward port (default 55433).
#   CURVED_TUNNEL_REMOTE_PORT Remote loopback port (default 55432).
#
# The script execs ssh, so the forwarded session owns this process; stop it
# with Ctrl-C. No credentials or secrets are ever printed.
set -euo pipefail

HOST="${CURVED_DEPLOY_HOST:-}"
SSH_USER="${CURVED_DEPLOY_USER:-deploy}"
IDENTITY="${CURVED_SSH_IDENTITY:-}"
KNOWN_HOSTS="${CURVED_SSH_KNOWN_HOSTS:-}"
LOCAL_PORT="${CURVED_TUNNEL_LOCAL_PORT:-55433}"
REMOTE_PORT="${CURVED_TUNNEL_REMOTE_PORT:-55432}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: deploy/agent-tunnel.sh --host HOST [options]

Forward a local port to the deployed Curved Postgres, which listens only on
the host loopback. The session is a foreground SSH process; stop it with
Ctrl-C.

Options:
  --host HOST             Host to tunnel to (required; or
                          CURVED_DEPLOY_HOST).
  --user USER             SSH user (default deploy, or CURVED_DEPLOY_USER).
  --identity PATH         Private key passed with -i (or CURVED_SSH_IDENTITY).
  --known-hosts PATH      known_hosts file (or CURVED_SSH_KNOWN_HOSTS).
  --local-port PORT       Local forward port (default 55433).
  --remote-port PORT      Remote loopback port (default 55432).
  --dry-run               Print the shell-quoted ssh command and exit.
  -h, --help              Show this message and exit.

Port 55432 is the local development database and is refused as a local port;
55433 is the tunnel convention. Local and remote ports must differ. SSH runs
with BatchMode, IdentitiesOnly, and StrictHostKeyChecking enabled.
EOF
}

argument_error() {
  printf 'agent-tunnel: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

fail() {
  printf 'agent-tunnel: error: %s\n' "${1:-failed}" >&2
  exit 1
}

info() {
  printf 'agent-tunnel: %s\n' "$1" >&2
}

validate_port() {
  local name=$1 value=$2
  case "$value" in
    '' | *[!0-9]*)
      argument_error "$name must be a port number, got '$value'"
      ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    argument_error "$name must be between 1 and 65535, got $value"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a host"
      fi
      HOST=$2
      shift 2
      ;;
    --user)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a user"
      fi
      SSH_USER=$2
      shift 2
      ;;
    --identity)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      IDENTITY=$2
      shift 2
      ;;
    --known-hosts)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      KNOWN_HOSTS=$2
      shift 2
      ;;
    --local-port)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a port"
      fi
      LOCAL_PORT=$2
      shift 2
      ;;
    --remote-port)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a port"
      fi
      REMOTE_PORT=$2
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      argument_error "unknown argument $1"
      ;;
    *)
      argument_error "unexpected argument $1"
      ;;
  esac
done

[ -n "$HOST" ] || argument_error "--host or CURVED_DEPLOY_HOST is required"
[ -n "$SSH_USER" ] || argument_error "--user must not be empty"

validate_port "--local-port" "$LOCAL_PORT"
validate_port "--remote-port" "$REMOTE_PORT"

if [ "$LOCAL_PORT" -eq 55432 ]; then
  argument_error \
    "local port 55432 is the local development database; use 55433"
fi

if [ "$LOCAL_PORT" -eq "$REMOTE_PORT" ]; then
  argument_error "local and remote ports must differ (both $LOCAL_PORT)"
fi

command -v ssh >/dev/null 2>&1 || fail "ssh is required"

SSH_ARGV=(
  ssh -N -T
  -o BatchMode=yes
  -o ExitOnForwardFailure=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
)
if [ -n "$IDENTITY" ]; then
  SSH_ARGV+=(-i "$IDENTITY")
fi
if [ -n "$KNOWN_HOSTS" ]; then
  SSH_ARGV+=(-o "UserKnownHostsFile=$KNOWN_HOSTS")
fi
SSH_ARGV+=(
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}"
  "${SSH_USER}@${HOST}"
)

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%q ' "${SSH_ARGV[@]}"
  printf '\n'
  exit 0
fi

info "forwarding 127.0.0.1:${LOCAL_PORT} -> ${HOST}:127.0.0.1:${REMOTE_PORT}"
exec "${SSH_ARGV[@]}"
