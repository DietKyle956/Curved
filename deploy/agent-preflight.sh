#!/usr/bin/env bash
# Prove that the local checkout matches the deployed release before agents run.
#
# The deployed host records each release in a state file with tag, sha, and at
# lines. This script reads that file over SSH, resolves the deployed sha in the
# local checkout, and fails unless it equals local HEAD exactly, so CLI and MCP
# runs use the code the host actually serves. With --require-tunnel it also
# probes the tunnel port, catching a missing forward before the first query.
#
# Usage:
#   deploy/agent-preflight.sh --host HOST [options]
#
# Environment:
#   CURVED_DEPLOY_HOST        Host running the stack (required).
#   CURVED_DEPLOY_USER        SSH user (default deploy).
#   CURVED_SSH_IDENTITY       Private key passed with -i.
#   CURVED_SSH_KNOWN_HOSTS    known_hosts file passed as -o
#                             UserKnownHostsFile.
#   CURVED_RELEASE_STATE      Remote state file (default
#                             /srv/curved/release-state).
#   CURVED_TUNNEL_LOCAL_PORT  Tunnel local port (default 55433).
#
# Exit codes: 0 the checkout matches the deployed commit, 1 a check failed, 2 a
# usage error. The state file is read but only its sha is ever printed.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

HOST="${CURVED_DEPLOY_HOST:-}"
SSH_USER="${CURVED_DEPLOY_USER:-deploy}"
IDENTITY="${CURVED_SSH_IDENTITY:-}"
KNOWN_HOSTS="${CURVED_SSH_KNOWN_HOSTS:-}"
STATE_PATH="${CURVED_RELEASE_STATE:-/srv/curved/release-state}"
CHECKOUT="${SCRIPT_DIR}/.."
LOCAL_PORT="${CURVED_TUNNEL_LOCAL_PORT:-55433}"
REQUIRE_TUNNEL=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: deploy/agent-preflight.sh --host HOST [options]

Read the deployed release state over SSH and require the local checkout HEAD
to be that exact commit. The local checkout defaults to the repository that
contains this script, so the script may be run from any directory.

Options:
  --host HOST             Host to read the state from (required; or
                          CURVED_DEPLOY_HOST).
  --user USER             SSH user (default deploy, or CURVED_DEPLOY_USER).
  --identity PATH         Private key passed with -i (or CURVED_SSH_IDENTITY).
  --known-hosts PATH      known_hosts file (or CURVED_SSH_KNOWN_HOSTS).
  --state-path PATH       Remote release state file (default
                          /srv/curved/release-state).
  --checkout PATH         Local checkout (default the repository root
                          containing this script).
  --local-port PORT       Tunnel probe port (default 55433).
  --require-tunnel        Also require a listener on 127.0.0.1:PORT.
  --dry-run               Print the plan and the shell-quoted ssh command
                          without contacting the host.
  -h, --help              Show this message and exit.

The state file must hold a sha= line of 7 to 40 lowercase hex characters that
resolves to a commit in the local checkout. On a mismatch the script prints
both revisions and the recovery command. Port 55432 is refused as the tunnel
probe port because it is the local development database; the tunnel uses 55433.

Exit codes: 0 parity holds, 1 a check failed, 2 a usage error.
EOF
}

argument_error() {
  printf 'agent-preflight: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

fail() {
  printf 'agent-preflight: error: %s\n' "${1:-failed}" >&2
  exit 1
}

recovery() {
  local sha=$1
  printf 'agent-preflight: recover with:\n'
  printf '  git fetch origin && git checkout %s\n' "$sha"
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
    --state-path)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      STATE_PATH=$2
      shift 2
      ;;
    --checkout)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      CHECKOUT=$2
      shift 2
      ;;
    --local-port)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a port"
      fi
      LOCAL_PORT=$2
      shift 2
      ;;
    --require-tunnel)
      REQUIRE_TUNNEL=1
      shift
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
[ -n "$STATE_PATH" ] || argument_error "--state-path must not be empty"

case "$STATE_PATH" in
  *[!A-Za-z0-9._/-]*)
    argument_error \
      "state path may contain only [A-Za-z0-9._/-], got '$STATE_PATH'"
    ;;
esac

validate_port "--local-port" "$LOCAL_PORT"

if [ "$LOCAL_PORT" -eq 55432 ]; then
  argument_error \
    "local port 55432 is the local development database; use 55433"
fi

command -v git >/dev/null 2>&1 || fail "git is required"

CHECKOUT=$(realpath -m -- "$CHECKOUT")
[ -d "$CHECKOUT" ] || fail "checkout $CHECKOUT does not exist"

REPO_ROOT=$(git -C "$CHECKOUT" rev-parse --show-toplevel 2>/dev/null) \
  || fail "checkout $CHECKOUT is not inside a git repository"
cd "$REPO_ROOT"

LOCAL_FULL=$(git rev-parse --verify HEAD) \
  || fail "could not resolve HEAD in $REPO_ROOT"
LOCAL_SHORT=$(git rev-parse --short HEAD) \
  || fail "could not resolve the short HEAD in $REPO_ROOT"

SSH_ARGV=(
  ssh
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
)
if [ -n "$IDENTITY" ]; then
  SSH_ARGV+=(-i "$IDENTITY")
fi
if [ -n "$KNOWN_HOSTS" ]; then
  SSH_ARGV+=(-o "UserKnownHostsFile=$KNOWN_HOSTS")
fi
SSH_ARGV+=("${SSH_USER}@${HOST}" cat -- "$STATE_PATH")

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'agent-preflight: checkout %s\n' "$REPO_ROOT"
  printf 'agent-preflight: state %s\n' "$STATE_PATH"
  if [ "$REQUIRE_TUNNEL" -eq 1 ]; then
    printf 'agent-preflight: tunnel probe 127.0.0.1:%s\n' "$LOCAL_PORT"
  fi
  printf '%q ' "${SSH_ARGV[@]}"
  printf '\n'
  exit 0
fi

command -v ssh >/dev/null 2>&1 || fail "ssh is required"

if ! STATE=$("${SSH_ARGV[@]}" 2>/dev/null); then
  fail "could not read $STATE_PATH on $HOST over SSH;"\
" check the key, known_hosts, and the state path"
fi

DEPLOYED_SHA=""
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in
    sha=*) DEPLOYED_SHA=${line#sha=} ;;
  esac
done <<<"$STATE"

[ -n "$DEPLOYED_SHA" ] \
  || fail "release state $STATE_PATH has no sha= line"

case "$DEPLOYED_SHA" in
  *[!0-9a-f]*)
    fail "release state $STATE_PATH has a malformed sha '$DEPLOYED_SHA'"
    ;;
esac
if [ "${#DEPLOYED_SHA}" -lt 7 ] || [ "${#DEPLOYED_SHA}" -gt 40 ]; then
  fail "release state $STATE_PATH has a malformed sha"\
" '$DEPLOYED_SHA'"
fi

if ! DEPLOYED_FULL=$(
  git rev-parse --verify --quiet "${DEPLOYED_SHA}^{commit}"
); then
  printf 'agent-preflight: error: the checkout does not contain deployed %s\n' \
    "$DEPLOYED_SHA" >&2
  recovery "$DEPLOYED_SHA" >&2
  exit 1
fi

if [ "$DEPLOYED_FULL" != "$LOCAL_FULL" ]; then
  printf 'agent-preflight: error: local and deployed revisions differ\n' >&2
  printf 'agent-preflight: local revision:    %s\n' "$LOCAL_FULL" >&2
  printf 'agent-preflight: deployed revision: %s\n' "$DEPLOYED_FULL" >&2
  recovery "$DEPLOYED_FULL" >&2
  exit 1
fi

if [ "$REQUIRE_TUNNEL" -eq 1 ]; then
  command -v timeout >/dev/null 2>&1 || fail "timeout is required"
  if ! timeout 3 bash -c \
    'exec 3<>"/dev/tcp/127.0.0.1/$1" && exec 3>&-' \
    _ "$LOCAL_PORT" 2>/dev/null; then
    fail "nothing is listening on 127.0.0.1:${LOCAL_PORT};"\
" start deploy/agent-tunnel.sh first"
  fi
fi

printf 'agent-preflight: ok %s (deployed %s)\n' "$LOCAL_SHORT" "$DEPLOYED_SHA"
