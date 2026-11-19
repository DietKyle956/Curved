#!/usr/bin/env bash
# Configure the GitHub pull_request webhook for the deployed Curved host.
#
# Deliveries go to https://$CURVED_DOMAIN/webhooks/github and are signed with
# GITHUB_WEBHOOK_SECRET from the environment file. The script lists the
# repository hooks, then creates the hook whose config.url matches the target
# URL, or updates it in place so the secret is always rotated. The request
# payload is streamed to `gh api` over stdin so the secret never appears in
# argv.
#
# Usage:
#   deploy/webhook.sh [--repo OWNER/NAME] [--url URL] [--env-file PATH]
#                     [--dry-run] [--help]
#
# Requires gh, python3, and git. Run it from anywhere inside the checkout.
set -euo pipefail

REPO=""
URL=""
ENV_FILE="deploy/.env"
DRY_RUN=0
TMP_DIR=""

usage() {
  cat <<'EOF'
Usage: deploy/webhook.sh [options]

Create or update the GitHub repository pull_request webhook for the deployed
Curved host. An existing hook with the target URL is always updated in place,
so the configured secret is reapplied on every run.

Options:
  --repo OWNER/NAME  Repository to configure (default: derived from the origin
                     remote).
  --url URL          Webhook target (default
                     https://$CURVED_DOMAIN/webhooks/github).
  --env-file PATH    Environment file (default deploy/.env).
  --dry-run          Print the plan without any write call.
  -h, --help         Show this message and exit.

The environment file supplies GITHUB_WEBHOOK_SECRET (required) and
CURVED_DOMAIN (used when --url is absent). A localhost or empty domain
requires an explicit --url. The secret is sent to gh on stdin and never
printed.
EOF
}

argument_error() {
  printf 'webhook: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

fail() {
  printf 'webhook: error: %s\n' "${1:-failed}" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

# Derive OWNER/NAME from the origin remote, accepting https, ssh, and
# scp-like forms. Prints nothing and returns nonzero when origin is absent or
# is not a hosted repository URL.
derive_repo() {
  local url
  url=$(git remote get-url origin 2>/dev/null) || return 1
  url=${url%.git}
  url=${url%/}
  case "$url" in
    *://*)
      url=${url#*://}
      url=${url#*/}
      ;;
    *:*)
      url=${url#*:}
      ;;
    *)
      return 1
      ;;
  esac
  case "$url" in
    */*) printf '%s\n' "$url" ;;
    *) return 1 ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires OWNER/NAME"
      fi
      REPO=$2
      shift 2
      ;;
    --url)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a URL"
      fi
      URL=$2
      shift 2
      ;;
    --env-file)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        argument_error "$1 requires a path"
      fi
      ENV_FILE=$2
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
    *)
      argument_error "unknown argument '$1'"
      ;;
  esac
done

command -v gh >/dev/null 2>&1 || fail "gh is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v git >/dev/null 2>&1 || fail "git is required"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || true
[ -n "$REPO_ROOT" ] || fail "not inside a git checkout; run this from the repository"
cd "$REPO_ROOT"

ENV_FILE=$(realpath -m -- "$ENV_FILE")
[ -r "$ENV_FILE" ] || fail "environment file $ENV_FILE is missing or unreadable"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-}"
[ -n "$WEBHOOK_SECRET" ] || fail "GITHUB_WEBHOOK_SECRET is not set in $ENV_FILE"

if [ -z "$URL" ]; then
  DOMAIN="${CURVED_DOMAIN:-}"
  [ -n "$DOMAIN" ] || fail "CURVED_DOMAIN is not set in $ENV_FILE; pass --url"
  domain_lower=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  case "$domain_lower" in
    localhost | 127.0.0.1 | ::1)
      fail "CURVED_DOMAIN is '$DOMAIN'; pass --url for a public webhook target"
      ;;
  esac
  URL="https://$DOMAIN/webhooks/github"
fi

if [ -z "$REPO" ]; then
  REPO=$(derive_repo) || argument_error "--repo OWNER/NAME is required: origin is not a usable GitHub remote"
fi

owner=${REPO%%/*}
name=${REPO#*/}
if [ -z "$owner" ] || [ -z "$name" ] || [ "${name#*/}" != "$name" ]; then
  argument_error "--repo must be OWNER/NAME, got '$REPO'"
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/curved-webhook.XXXXXX")
HOOKS_FILE="$TMP_DIR/hooks.json"
PAYLOAD_FILE="$TMP_DIR/payload.json"
CREATED_FILE="$TMP_DIR/created.json"

if ! gh api "repos/$REPO/hooks?per_page=100" >"$HOOKS_FILE" 2>/dev/null; then
  fail "gh api failed while listing hooks for $REPO"
fi

# Build the desired payload and decide what to do without passing the secret
# through argv or the environment of any later gh call.
plan=$(
  WEBHOOK_TARGET_URL="$URL" WEBHOOK_TARGET_SECRET="$WEBHOOK_SECRET" \
    python3 - "$HOOKS_FILE" "$PAYLOAD_FILE" <<'PY'
import json
import os
import sys

hooks_path, payload_path = sys.argv[1], sys.argv[2]
target_url = os.environ["WEBHOOK_TARGET_URL"]
secret = os.environ["WEBHOOK_TARGET_SECRET"]

try:
    with open(hooks_path, encoding="utf-8") as handle:
        hooks = json.load(handle)
except (OSError, ValueError):
    sys.exit(1)

if not isinstance(hooks, list):
    sys.exit(1)

payload = {
    "active": True,
    "events": ["pull_request"],
    "config": {
        "url": target_url,
        "content_type": "json",
        "secret": secret,
    },
}
with open(payload_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)

match = None
for hook in hooks:
    if not isinstance(hook, dict):
        continue
    config = hook.get("config")
    if isinstance(config, dict) and config.get("url") == target_url:
        match = hook
        break

if match is None:
    print("create")
    sys.exit(0)

hook_id = match.get("id")
if not isinstance(hook_id, int):
    sys.exit(1)

print("%d update" % hook_id)
PY
) || fail "could not read the hook list from gh"

case "$plan" in
  create)
    if [ "$DRY_RUN" -eq 1 ]; then
      printf 'webhook: would create %s\n' "$URL"
      exit 0
    fi
    if ! gh api --method POST "repos/$REPO/hooks" --input - \
      >"$CREATED_FILE" 2>/dev/null <"$PAYLOAD_FILE"; then
      fail "gh api failed while creating the webhook"
    fi
    hook_id=$(
      python3 -c '
import json
import sys

try:
    data = json.load(sys.stdin)
except ValueError:
    sys.exit(1)
hook_id = data.get("id") if isinstance(data, dict) else None
if not isinstance(hook_id, int):
    sys.exit(1)
print(hook_id)
' <"$CREATED_FILE"
    ) || fail "gh returned an unexpected hook payload"
    printf 'webhook: created %s %s\n' "$hook_id" "$URL"
    ;;
  *)
    hook_id=${plan%% *}
    if [ "${plan##* }" != "update" ]; then
      fail "could not determine the webhook plan"
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      printf 'webhook: would update %s %s\n' "$hook_id" "$URL"
      exit 0
    fi
    if ! gh api --method PATCH "repos/$REPO/hooks/$hook_id" --input - \
      >/dev/null 2>&1 <"$PAYLOAD_FILE"; then
      fail "gh api failed while updating the webhook"
    fi
    printf 'webhook: updated %s %s\n' "$hook_id" "$URL"
    ;;
esac
