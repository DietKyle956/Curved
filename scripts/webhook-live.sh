#!/usr/bin/env bash
# Webhook drill: prove the whole live chain end to end against the deployed
# instance. A real pull request is opened in a real GitHub repository, GitHub
# delivers the hook to the deployed app, the app writes to the deployed
# Postgres, the issue timeline grows a git event, and the issue lands in the
# expected status. Not part of npm test or CI; run it by hand when the webhook
# chain must be trusted.
#
# The drill never touches main: the PR is based on a throwaway branch cut from
# main, so no CI, release, or deploy runs. Everything it creates is removed by
# the EXIT trap.
set -euo pipefail

CLI=${CURVED_CLI:-curved}
REPO=""
PROJECT="WHK"
TIMEOUT=180
DRAFT=0
KEEP=0

usage() {
  cat <<'EOF'
Usage: bash scripts/webhook-live.sh [options]

Exercises the live webhook chain: hook config -> real PR -> GitHub delivery ->
deployed app -> deployed Postgres -> issue timeline -> merge.

Options:
  --repo OWNER/NAME   Repository to drill. Default: the current GitHub repo
                      (gh repo view --json nameWithOwner --jq .nameWithOwner).
  --project KEY       Curved project for the drill issue. Default: WHK.
  --timeout SECONDS   How long to wait for each status change. Default: 180.
  --draft             Open the PR as a draft, assert the issue stays
                      in_progress, then mark it ready for review and assert the
                      ready_for_review delivery moves the issue to in_review.
  --keep              Keep the drill project unarchived on success.
  -h, --help          Show this help.

Prerequisites:
  gh                 Authenticated with the repo and workflow scopes.
  git                With push access to --repo.
  curved             On PATH, or set CURVED_CLI to the CLI entrypoint.
  Curved Postgres    The deployed database must be reachable, which means the
                     Curved tunnel is up (curved tunnel start).

Runtime needs read access to the repository hooks and issues. Cleanup closes
the PR, deletes the throwaway branches and worktree, and archives the drill
project unless --keep was given.
EOF
}

fail() {
  printf 'webhook-live: FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS %s\n' "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || fail "--repo needs OWNER/NAME"
      REPO=$2
      shift 2
      ;;
    --project)
      [ $# -ge 2 ] || fail "--project needs KEY"
      PROJECT=$2
      shift 2
      ;;
    --timeout)
      [ $# -ge 2 ] || fail "--timeout needs SECONDS"
      case "$2" in
        '' | *[!0-9]*) fail "--timeout must be a positive integer, got '$2'" ;;
      esac
      [ "$2" -gt 0 ] || fail "--timeout must be positive, got '$2'"
      TIMEOUT=$2
      shift 2
      ;;
    --draft)
      DRAFT=1
      shift
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option '$1' (see --help)"
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

command -v gh >/dev/null 2>&1 || fail "gh is required"
command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "node is required"
if ! command -v "$CLI" >/dev/null 2>&1; then
  fail "the Curved CLI '$CLI' is not on PATH; set CURVED_CLI or install curved"
fi
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated; run 'gh auth login' (repo and workflow scopes)"
"$CLI" project list >/dev/null 2>&1 ||
  fail "cannot reach the Curved database; start the tunnel with 'curved tunnel start'"

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) ||
    fail "cannot resolve the repository; pass --repo OWNER/NAME"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/curved-webhook-live.XXXXXX")
HOOK_ID=""
HOOK_URL=""
issue=""
head=""
base=""
pr=""

report_failure() {
  printf 'webhook-live: FAIL %s\n' "$1" >&2
  if [ -n "$HOOK_ID" ]; then
    gh api "repos/$REPO/hooks/$HOOK_ID/deliveries?per_page=10" \
      --jq '.[] | "  \(.event) \(.action // "-") \(.status) \(.status_code // "-") \(.delivered_at)"' >&2 || true
  else
    printf '  (no hook id captured, deliveries unavailable)\n' >&2
  fi
  if [ -n "$issue" ]; then
    "$CLI" issue show "$issue" >&2 || true
  fi
  exit 1
}

cleanup() {
  trap - EXIT
  set +e
  if [ -n "$pr" ]; then
    gh pr close "$pr" --repo "$REPO" --delete-branch=false >/dev/null 2>&1 || true
  fi
  refs=()
  if [ -n "$head" ]; then
    refs+=("$head")
  fi
  if [ -n "$base" ]; then
    refs+=("$base")
  fi
  if [ ${#refs[@]} -gt 0 ]; then
    git push -q origin --delete "${refs[@]}" >/dev/null 2>&1 || true
  fi
  git worktree remove --force "$TMP/wt" >/dev/null 2>&1 || true
  if [ -n "$head" ]; then
    git branch -D "$head" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  if [ "$KEEP" -eq 0 ]; then
    "$CLI" project archive "$PROJECT" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

issue_json() {
  "$CLI" issue show "$1" --json
}

status_of() {
  node -e 'let raw = ""; process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => { process.stdout.write(String(JSON.parse(raw).status)); });'
}

assert_git_event() {
  local key=$1 pr_number=$2 action=$3 to=$4 payload
  payload=$(issue_json "$key") || report_failure "cannot read issue $key"
  printf '%s' "$payload" | KEY=$key PR_NUMBER=$pr_number ACTION=$action TO=$to node -e '
const fail = (message) => {
  process.stderr.write(`webhook-live: FAIL ${message}\n`);
  process.exit(1);
};
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
  let issue;
  try {
    issue = JSON.parse(raw);
  } catch {
    fail(`cannot parse issue JSON for ${process.env.KEY}`);
  }
  const body = `pull request #${process.env.PR_NUMBER} ${process.env.ACTION}`;
  const events = Array.isArray(issue.events) ? issue.events : [];
  const matches = events.filter((event) => event && event.actorType === "git" && event.body === body);
  if (matches.length === 0) {
    fail(`no git event "${body}" on ${process.env.KEY}`);
  }
  if (!matches.some((event) => event.toStatus === process.env.TO)) {
    const seen = matches.map((event) => event.toStatus).join(", ");
    fail(`git event "${body}" on ${process.env.KEY} moved to ${seen}, expected ${process.env.TO}`);
  }
});
' || exit 1
}

wait_for_status() {
  local key=$1 wanted=$2 status="" deadline
  deadline=$((SECONDS + TIMEOUT))
  while :; do
    status=$(issue_json "$key" | status_of) || report_failure "cannot read issue $key"
    if [ "$status" = "$wanted" ]; then
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      report_failure "$key did not reach $wanted within ${TIMEOUT}s (last status: $status)"
    fi
    sleep 2
  done
}

# --- 1. Hook config --------------------------------------------------------
hooks=$(gh api "repos/$REPO/hooks?per_page=100" --jq \
  '.[] | select(.active == true and (.events | index("pull_request")) and (.config.content_type == "json") and (.config.url | endswith("/webhooks/github"))) | "\(.id) \(.config.url)"') ||
  report_failure "cannot list hooks for $REPO"
if [ -z "$hooks" ]; then
  fail "$REPO has no active pull_request json hook ending in /webhooks/github; create it with deploy/webhook.sh"
fi
hook_count=$(printf '%s\n' "$hooks" | grep -c '^[^ ]' || true)
if [ "$hook_count" -gt 1 ]; then
  printf 'webhook-live: FAIL %s has %s matching hooks:\n%s\n' "$REPO" "$hook_count" "$hooks" >&2
  exit 1
fi
HOOK_ID=${hooks%% *}
HOOK_URL=${hooks#* }
pass "hook config: hook $HOOK_ID $HOOK_URL"

# --- 2. Project ------------------------------------------------------------
project_note="present"
if project_json=$("$CLI" project show "$PROJECT" --json 2>/dev/null); then
  archived=$(printf '%s' "$project_json" | node -e 'let raw = ""; process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => { const value = JSON.parse(raw).archivedAt; process.stdout.write(value === null || value === undefined ? "null" : String(value)); });')
  if [ "$archived" != "null" ]; then
    "$CLI" project restore "$PROJECT" >/dev/null ||
      report_failure "cannot restore project $PROJECT"
    project_note="restored"
  fi
else
  "$CLI" project add "$PROJECT" "Webhook live drill" >/dev/null ||
    report_failure "cannot create project $PROJECT"
  project_note="created"
fi
pass "project: $PROJECT $project_note"

# --- 3. Issue --------------------------------------------------------------
stamp=$(date -u +%Y%m%dT%H%M%SZ)
issue=$("$CLI" issue add "$PROJECT" "Webhook live drill $stamp" --status in_progress --json |
  node -e 'let raw = ""; process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => { process.stdout.write(String(JSON.parse(raw).key)); });') ||
  report_failure "cannot create a drill issue in $PROJECT"
pass "issue: $issue created at in_progress"

# --- 4. Branch -------------------------------------------------------------
head=$("$CLI" git-branch "$issue") || report_failure "cannot resolve the branch for $issue"
if [ "$head" != "$issue" ]; then
  case "$head" in
    "$issue"-*) ;;
    *) fail "git-branch returned '$head', expected $issue or $issue-*" ;;
  esac
fi
pass "branch: $head"

# --- 5. Pushed -------------------------------------------------------------
git fetch -q origin main || report_failure "cannot fetch origin/main"
git worktree add -b "$head" "$TMP/wt" origin/main >/dev/null ||
  report_failure "cannot create a worktree for $head"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP/wt/webhook-live-drill.txt"
git -C "$TMP/wt" -c user.name="Curved webhook drill" -c user.email="drill@curved.invalid" \
  add webhook-live-drill.txt
git -C "$TMP/wt" -c user.name="Curved webhook drill" -c user.email="drill@curved.invalid" \
  commit -q -m "$issue webhook live drill"
git -C "$TMP/wt" push -q origin "$head" || report_failure "cannot push $head"
pass "pushed: $head committed and pushed"

# --- 6. Base ---------------------------------------------------------------
base="webhook-drill-$(date -u +%H%M%S)"
git push -q origin "origin/main:refs/heads/$base" || report_failure "cannot create base branch $base"
pass "base: $base"

# --- 7. PR -----------------------------------------------------------------
create_args=(gh pr create --repo "$REPO" --base "$base" --head "$head"
  --title "$issue live webhook drill"
  --body "Automated webhook drill for $issue; safe to close.")
if [ "$DRAFT" -eq 1 ]; then
  create_args+=(--draft)
fi
pr_url=$("${create_args[@]}") || report_failure "cannot open a pull request for $head"
pr=${pr_url##*/}
case "$pr" in
  '' | *[!0-9]*) fail "cannot parse a pull request number from '$pr_url'" ;;
esac
if [ "$DRAFT" -eq 1 ]; then
  pass "pr: #$pr (draft) based on $base"
else
  pass "pr: #$pr based on $base"
fi

# --- 8. Opened -------------------------------------------------------------
if [ "$DRAFT" -eq 0 ]; then
  wait_for_status "$issue" in_review
  assert_git_event "$issue" "$pr" opened in_review
  pass "opened: $issue moved to in_review via PR #$pr"
fi

# --- 9. Draft mode ---------------------------------------------------------
if [ "$DRAFT" -eq 1 ]; then
  sleep 10
  draft_status=$(issue_json "$issue" | status_of) || report_failure "cannot read issue $issue"
  if [ "$draft_status" != "in_progress" ]; then
    report_failure "a draft PR moved $issue to $draft_status, expected in_progress"
  fi
  gh pr ready "$pr" --repo "$REPO" >/dev/null || report_failure "cannot mark PR #$pr ready for review"
  wait_for_status "$issue" in_review
  assert_git_event "$issue" "$pr" ready_for_review in_review
  pass "ready_for_review: $issue moved to in_review via PR #$pr"
fi

# --- 10. Merged ------------------------------------------------------------
if gh pr merge "$pr" --repo "$REPO" --merge --delete-branch=false >/dev/null; then
  wait_for_status "$issue" done
  assert_git_event "$issue" "$pr" closed done
  pass "merged: $issue moved to done via PR #$pr"
else
  printf 'SKIP merged leg: gh pr merge refused; the drill base branch was not merged\n' >&2
fi

printf 'webhook-live: ok\n'
