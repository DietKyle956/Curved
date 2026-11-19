#!/usr/bin/env bash
# Webhook gate: exercise deploy/webhook.sh against a stub gh in a throwaway
# PATH, so no GitHub account, network, or real credentials are touched.
# Covers the create path and the update path, including the realistic GitHub
# shape where a hook response omits config.secret, the dry-run plan, a missing
# secret, the localhost guard, and secret secrecy in output and argv.
#
# The stub logs every argv line to <state>/gh.log and every stdin payload to
# <state>/stdin.log, then emits canned JSON for list, POST, and PATCH. PASS
# lines name each assertion; the first failed assertion prints FAIL and exits 1.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WEBHOOK="$ROOT_DIR/deploy/webhook.sh"
REPO="smoke-owner/smoke-repo"
DOMAIN="curved.smoke"
URL="https://$DOMAIN/webhooks/github"
SECRET="smoke-webhook-secret-3c1f9a2e"

unset GITHUB_WEBHOOK_SECRET 2>/dev/null || true

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/curved-webhook-smoke.XXXXXX")
cleanup() {
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS %s\n' "$1"
}

[ -f "$WEBHOOK" ] || fail "deploy/webhook.sh is missing"
[ -x "$WEBHOOK" ] || fail "deploy/webhook.sh is not executable"
bash -n "$WEBHOOK" || fail "deploy/webhook.sh does not parse (bash -n)"
pass "deploy/webhook.sh is executable and parses"

cd "$ROOT_DIR"

STUB_DIR="$TMP_DIR/bin"
STATE_DIR="$TMP_DIR/state"
LOG_DIR="$TMP_DIR/logs"
mkdir -p "$STUB_DIR" "$STATE_DIR" "$LOG_DIR"

cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

state=${STUB_STATE:?}
{
  printf 'call'
  for arg in "$@"; do
    printf ' %s' "$arg"
  done
  printf '\n'
} >> "$state/gh.log"

reads_stdin=0
expect_input=0
for arg in "$@"; do
  if [ "$expect_input" -eq 1 ] && [ "$arg" = "-" ]; then
    reads_stdin=1
  fi
  if [ "$arg" = "--input" ]; then
    expect_input=1
  else
    expect_input=0
  fi
done

if [ "$reads_stdin" -eq 1 ]; then
  cat >> "$state/stdin.log"
fi

joined=" $* "
case "$joined" in
  *" --method POST "*)
    printf '{"id":4242,"active":true}\n'
    ;;
  *" --method PATCH "*)
    printf '{"id":7676,"active":true}\n'
    ;;
  *"hooks?per_page=100"*)
    cat "$state/hooks.json"
    ;;
  *)
    printf '{}\n'
    ;;
esac
STUB

chmod +x "$STUB_DIR/gh"
export PATH="$STUB_DIR:$PATH"
export STUB_STATE="$STATE_DIR"

ENV_FILE="$TMP_DIR/webhook.env"
cat > "$ENV_FILE" <<EOF
CURVED_DOMAIN=$DOMAIN
GITHUB_WEBHOOK_SECRET=$SECRET
EOF
chmod 600 "$ENV_FILE"

LOCALHOST_ENV="$TMP_DIR/localhost.env"
cat > "$LOCALHOST_ENV" <<EOF
CURVED_DOMAIN=localhost
GITHUB_WEBHOOK_SECRET=$SECRET
EOF
chmod 600 "$LOCALHOST_ENV"

MISSING_SECRET_ENV="$TMP_DIR/missing-secret.env"
cat > "$MISSING_SECRET_ENV" <<EOF
CURVED_DOMAIN=$DOMAIN
EOF
chmod 600 "$MISSING_SECRET_ENV"

RC=0
run_webhook() {
  local name=$1
  shift
  RC=0
  "$@" >"$LOG_DIR/$name.out" 2>"$LOG_DIR/$name.err" </dev/null || RC=$?
}

reset_gh() {
  rm -f -- "$STATE_DIR/gh.log" "$STATE_DIR/stdin.log"
}

set_hooks() {
  printf '%s\n' "$1" > "$STATE_DIR/hooks.json"
}

out_line() {
  cat "$LOG_DIR/$1.out"
}

err_text() {
  cat "$LOG_DIR/$1.err"
}

assert_no_mutation() {
  local label=$1
  if grep -q -- '--method' "$STATE_DIR/gh.log" 2>/dev/null; then
    fail "$label issued a mutating gh call: $(grep -- '--method' "$STATE_DIR/gh.log")"
  fi
}

# --- Create path: no hook at the target URL --------------------------------
set_hooks '[]'
reset_gh
run_webhook create "$WEBHOOK" --repo "$REPO" --env-file "$ENV_FILE"
[ "$RC" -eq 0 ] || fail "create path exited $RC: $(err_text create)"
[ "$(out_line create)" = "webhook: created 4242 $URL" ] ||
  fail "create output was '$(out_line create)'"
grep -qF -- "repos/$REPO/hooks?per_page=100" "$STATE_DIR/gh.log" ||
  fail "create did not list the repository hooks"
grep -qF -- ' --method POST ' "$STATE_DIR/gh.log" ||
  fail "create did not POST the new hook"
grep -qF -- "$SECRET" "$STATE_DIR/stdin.log" ||
  fail "create did not send the secret over stdin"
pass "an absent hook is created, with the secret on stdin and the URL derived from CURVED_DOMAIN"

# --- Update path: a hook with the same URL but stale settings --------------
cat > "$STATE_DIR/hooks.json" <<EOF
[{"id":77,"active":false,"events":["push"],"config":{"url":"$URL","content_type":"form","secret":"stale-secret"}}]
EOF
reset_gh
run_webhook update "$WEBHOOK" --repo "$REPO" --url "$URL" --env-file "$ENV_FILE"
[ "$RC" -eq 0 ] || fail "update path exited $RC: $(err_text update)"
[ "$(out_line update)" = "webhook: updated 77 $URL" ] ||
  fail "update output was '$(out_line update)'"
grep -qF -- " --method PATCH repos/$REPO/hooks/77 " "$STATE_DIR/gh.log" ||
  fail "update did not PATCH hook 77"
pass "a hook with the same URL is updated with the pull_request event"

# --- Update path: the API omits config.secret from hook responses ----------
cat > "$STATE_DIR/hooks.json" <<EOF
[{"id":77,"active":true,"events":["pull_request"],"config":{"url":"$URL","content_type":"json"}}]
EOF
reset_gh
run_webhook secretless "$WEBHOOK" --repo "$REPO" --url "$URL" --env-file "$ENV_FILE"
[ "$RC" -eq 0 ] || fail "secretless hook update exited $RC: $(err_text secretless)"
[ "$(out_line secretless)" = "webhook: updated 77 $URL" ] ||
  fail "secretless hook output was '$(out_line secretless)'"
grep -qF -- " --method PATCH repos/$REPO/hooks/77 " "$STATE_DIR/gh.log" ||
  fail "a hook without config.secret was not PATCHed"
grep -qF -- "$SECRET" "$STATE_DIR/stdin.log" ||
  fail "the update did not reapply the secret over stdin"
pass "an existing hook is always updated and the secret reapplied, even when the API omits config.secret"

# --- Dry run: plan only, never mutate ---------------------------------------
set_hooks '[]'
reset_gh
run_webhook dryrun "$WEBHOOK" --repo "$REPO" --url "$URL" --env-file "$ENV_FILE" --dry-run
[ "$RC" -eq 0 ] || fail "dry-run exited $RC: $(err_text dryrun)"
[ "$(out_line dryrun)" = "webhook: would create $URL" ] ||
  fail "dry-run output was '$(out_line dryrun)'"
assert_no_mutation "the dry run"
grep -qF -- 'hooks?per_page=100' "$STATE_DIR/gh.log" ||
  fail "dry-run skipped the hook listing"
pass "--dry-run reports the plan without mutating anything"

# --- Missing secret --------------------------------------------------------
reset_gh
run_webhook nosecret "$WEBHOOK" --repo "$REPO" --url "$URL" --env-file "$MISSING_SECRET_ENV"
[ "$RC" -ne 0 ] || fail "a missing GITHUB_WEBHOOK_SECRET exited zero"
grep -qF -- 'webhook: error:' "$LOG_DIR/nosecret.err" ||
  fail "a missing secret did not print a webhook: error line"
grep -qF -- 'GITHUB_WEBHOOK_SECRET' "$LOG_DIR/nosecret.err" ||
  fail "a missing secret did not name GITHUB_WEBHOOK_SECRET"
pass "a missing GITHUB_WEBHOOK_SECRET fails with a webhook: error line"

# --- Localhost guard -------------------------------------------------------
reset_gh
run_webhook localhost "$WEBHOOK" --repo "$REPO" --env-file "$LOCALHOST_ENV"
[ "$RC" -ne 0 ] || fail "a localhost CURVED_DOMAIN exited zero"
grep -qF -- 'webhook: error:' "$LOG_DIR/localhost.err" ||
  fail "a localhost domain did not print a webhook: error line"
pass "a localhost domain without --url is rejected"

# --- Secret secrecy --------------------------------------------------------
if grep -rqF -- "$SECRET" "$LOG_DIR"; then
  fail "the webhook secret appeared on stdout or stderr"
fi
pass "the webhook secret never appears on stdout or stderr"

if grep -qF -- "$SECRET" "$STATE_DIR/gh.log" 2>/dev/null; then
  fail "the webhook secret appeared in the gh argument list"
fi
pass "the webhook secret never appears in the gh argument list"

printf 'webhook-smoke: all checks passed\n'
