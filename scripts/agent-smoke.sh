#!/usr/bin/env bash
# Agent gate: exercise deploy/agent-tunnel.sh and deploy/agent-preflight.sh
# against a stub ssh and a throwaway git fixture, so no Docker, database, or
# network is touched beyond a loopback listener. Covers the 55432 refusal, the
# strict SSH option set, the local/deployed parity comparison, the recovery
# text, malformed and missing state, an unreadable state, the tunnel probe,
# and the --dry-run paths that must not contact SSH.
#
# Stub ssh knobs, set in the environment of a scenario:
#   STUB_SSH_LOG   file the stub appends its argv to
#   STUB_STATE     file whose contents the stub prints when argv contains cat
#   STUB_SSH_EXIT  when set, the stub exits with this code instead
#
# Each assertion prints a PASS line; the first failure prints
# `agent-smoke: FAIL <reason>` and exits 1.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TUNNEL="$ROOT_DIR/deploy/agent-tunnel.sh"
PREFLIGHT="$ROOT_DIR/deploy/agent-preflight.sh"
STATE_PATH="/srv/curved/release-state"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/curved-agent-smoke.XXXXXX")
LISTENER_PID=""
cleanup() {
  if [ -n "$LISTENER_PID" ]; then
    kill "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

CHECKS=0
fail() {
  printf 'agent-smoke: FAIL %s\n' "${1:-unknown failure}" >&2
  exit 1
}

pass() {
  CHECKS=$((CHECKS + 1))
  printf 'PASS %s\n' "$1"
}

# --- Helpers parse and are executable -------------------------------------
for script in "$TUNNEL" "$PREFLIGHT"; do
  [ -f "$script" ] || fail "$script is missing"
  [ -x "$script" ] || fail "$script is not executable"
  bash -n "$script" || fail "$script does not parse (bash -n)"
done
pass "deploy/agent-tunnel.sh and deploy/agent-preflight.sh are executable and parse under bash -n"

# --- Stub ssh and fixture git repository -----------------------------------
STUB_DIR="$TMP_DIR/bin"
mkdir -p "$STUB_DIR" "$TMP_DIR/out"
STUB_SSH_LOG="$TMP_DIR/ssh.log"
: > "$STUB_SSH_LOG"

cat > "$STUB_DIR/ssh" <<'STUB'
#!/usr/bin/env bash
# Never touches the network. Logs argv and answers a `cat` request from the
# state fixture, or exits with the requested code.
printf '%s\n' "$*" >> "$STUB_SSH_LOG"
if [ -n "${STUB_SSH_EXIT:-}" ]; then
  printf 'ssh: stub exiting %s\n' "$STUB_SSH_EXIT" >&2
  exit "$STUB_SSH_EXIT"
fi
has_cat=0
for arg in "$@"; do
  if [ "$arg" = "cat" ]; then
    has_cat=1
  fi
done
if [ "$has_cat" -eq 1 ] && [ -n "${STUB_STATE:-}" ] && [ -f "$STUB_STATE" ]; then
  cat -- "$STUB_STATE"
fi
exit 0
STUB
chmod +x "$STUB_DIR/ssh"

export PATH="$STUB_DIR:$PATH"
export STUB_SSH_LOG

FIXTURE="$TMP_DIR/repo"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init -q -b main
printf 'one\n' > "$FIXTURE/file.txt"
git -C "$FIXTURE" -c user.name=smoke -c user.email=smoke@example.invalid \
  add file.txt
git -C "$FIXTURE" -c user.name=smoke -c user.email=smoke@example.invalid \
  commit -q -m one
FIRST_FULL=$(git -C "$FIXTURE" rev-parse HEAD) || fail "could not resolve the fixture HEAD"
FIRST_SHORT=$(git -C "$FIXTURE" rev-parse --short HEAD) \
  || fail "could not resolve the fixture short HEAD"

RUN_OUT=""
RUN_RC=0
run() {
  RUN_RC=0
  RUN_OUT=$("$@" 2>&1) || RUN_RC=$?
}

out_has() {
  local needle=$1 label=$2
  case "$RUN_OUT" in
    *"$needle"*) ;;
    *)
      fail "$label: output does not contain '$needle'; got: $RUN_OUT"
      ;;
  esac
}

write_state() {
  local sha=$1 file=$2
  printf 'tag=curved:%s\nsha=%s\nat=2026-01-01T00:00:00Z\n' "$sha" "$sha" > "$file"
}

# --- Preflight parity ------------------------------------------------------
PARITY_STATE="$TMP_DIR/state-parity"
write_state "$FIRST_SHORT" "$PARITY_STATE"
export STUB_STATE="$PARITY_STATE"
unset STUB_SSH_EXIT || true
: > "$STUB_SSH_LOG"

run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH"
[ "$RUN_RC" -eq 0 ] || fail "preflight parity exited $RUN_RC: $RUN_OUT"
out_has "agent-preflight: ok" "preflight parity"
out_has "$FIRST_SHORT" "preflight parity"
grep -qF -- "cat -- $STATE_PATH" "$STUB_SSH_LOG" \
  || fail "preflight did not read $STATE_PATH over ssh"
pass "preflight passes when the deployed sha equals HEAD and prints agent-preflight: ok"

# --- Preflight mismatch (a second commit is now HEAD) ----------------------
printf 'two\n' > "$FIXTURE/file.txt"
git -C "$FIXTURE" -c user.name=smoke -c user.email=smoke@example.invalid \
  commit -q -am two
SECOND_FULL=$(git -C "$FIXTURE" rev-parse HEAD) || fail "could not resolve the second HEAD"
SECOND_SHORT=$(git -C "$FIXTURE" rev-parse --short HEAD) \
  || fail "could not resolve the second short HEAD"

run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH"
[ "$RUN_RC" -ne 0 ] || fail "preflight passed with mismatched local and deployed revisions"
out_has "local and deployed revisions differ" "preflight mismatch"
out_has "$SECOND_FULL" "preflight mismatch"
out_has "$FIRST_FULL" "preflight mismatch"
out_has "git fetch origin && git checkout" "preflight mismatch"
pass "preflight fails on a mismatch, prints both revisions and the recovery command"

# --- Preflight deployed sha absent from the checkout -----------------------
ABSENT_SHA="0123456789abcdef0123456789abcdef01234567"
ABSENT_STATE="$TMP_DIR/state-absent"
printf 'tag=curved:abc\nsha=%s\n' "$ABSENT_SHA" > "$ABSENT_STATE"
export STUB_STATE="$ABSENT_STATE"

run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH"
[ "$RUN_RC" -ne 0 ] || fail "preflight passed for a deployed sha absent from the checkout"
out_has "the checkout does not contain deployed $ABSENT_SHA" "preflight absent sha"
out_has "git fetch origin && git checkout" "preflight absent sha"
pass "preflight fails when the deployed sha is absent and says the checkout does not contain it"

# --- Preflight empty state -------------------------------------------------
EMPTY_STATE="$TMP_DIR/state-empty"
printf 'tag=curved:abc\n' > "$EMPTY_STATE"
export STUB_STATE="$EMPTY_STATE"

run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH"
[ "$RUN_RC" -ne 0 ] || fail "preflight passed with an empty state file"
out_has "has no sha= line" "preflight empty state"
pass "preflight fails on an empty state with a missing sha message"

# --- Preflight malformed sha ----------------------------------------------
NOTHEX_STATE="$TMP_DIR/state-nothex"
printf 'tag=curved:abc\nsha=nothex\n' > "$NOTHEX_STATE"
export STUB_STATE="$NOTHEX_STATE"

run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH"
[ "$RUN_RC" -ne 0 ] || fail "preflight passed with sha=nothex"
out_has "malformed sha" "preflight malformed sha"
pass "preflight rejects sha=nothex as malformed"

# --- Preflight unreadable state -------------------------------------------
export STUB_STATE="$PARITY_STATE"
export STUB_SSH_EXIT=255

run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH"
[ "$RUN_RC" -ne 0 ] || fail "preflight passed when ssh could not read the state"
out_has "could not read $STATE_PATH" "preflight unreadable state"
pass "preflight fails when ssh cannot read the state"

unset STUB_SSH_EXIT || true
export STUB_STATE="$TMP_DIR/state-current"

# --- Loopback listener fixture --------------------------------------------
cat > "$TMP_DIR/port.js" <<'NODE'
const net = require('node:net');
const fs = require('node:fs');
const mode = process.argv[2];
const file = process.argv[3];
if (mode === 'listen') {
  const server = net.createServer((socket) => socket.end());
  server.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(file, String(server.address().port));
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  const server = net.createServer();
  server.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(file, String(server.address().port));
    server.close();
  });
}
NODE

wait_for_file() {
  local file=$1 label=$2 tries=0
  while [ ! -s "$file" ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 200 ] || fail "timed out waiting for $label"
    sleep 0.05
  done
}

FREE_PORT_FILE="$TMP_DIR/free.port"
node "$TMP_DIR/port.js" free "$FREE_PORT_FILE" \
  || fail "could not select a free loopback port"
wait_for_file "$FREE_PORT_FILE" "a free port"
FREE_PORT=$(cat "$FREE_PORT_FILE")
case "$FREE_PORT" in
  '' | *[!0-9]*) fail "the free port fixture produced '$FREE_PORT'" ;;
esac
[ "$FREE_PORT" -ne 55432 ] || fail "the free port fixture landed on 55432"
[ "$FREE_PORT" -ne 55433 ] || fail "the free port fixture landed on 55433"

# The current checkout HEAD is the second commit, so a passing state uses it.
write_state "$SECOND_SHORT" "$STUB_STATE"

# --- Preflight --require-tunnel with no listener --------------------------
run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH" \
  --require-tunnel --local-port "$FREE_PORT"
[ "$RUN_RC" -ne 0 ] || fail "preflight --require-tunnel passed with no listener on $FREE_PORT"
out_has "nothing is listening on 127.0.0.1:$FREE_PORT" "preflight missing tunnel"
out_has "deploy/agent-tunnel.sh" "preflight missing tunnel"
pass "preflight --require-tunnel fails when nothing listens and names deploy/agent-tunnel.sh"

# --- Preflight --require-tunnel against a real loopback listener ----------
LISTENER_PORT_FILE="$TMP_DIR/listener.port"
rm -f "$LISTENER_PORT_FILE"
node "$TMP_DIR/port.js" listen "$LISTENER_PORT_FILE" &
LISTENER_PID=$!
wait_for_file "$LISTENER_PORT_FILE" "the loopback listener"
LISTENER_PORT=$(cat "$LISTENER_PORT_FILE")
case "$LISTENER_PORT" in
  '' | *[!0-9]*) fail "the listener fixture produced '$LISTENER_PORT'" ;;
esac

run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH" \
  --require-tunnel --local-port "$LISTENER_PORT"
[ "$RUN_RC" -eq 0 ] || fail "preflight --require-tunnel failed against a live listener: $RUN_OUT"
out_has "agent-preflight: ok" "preflight live tunnel"

kill "$LISTENER_PID" 2>/dev/null || true
wait "$LISTENER_PID" 2>/dev/null || true
LISTENER_PID=""
pass "preflight --require-tunnel passes against a live loopback listener"

# --- Preflight refuses the local development port -------------------------
run "$PREFLIGHT" --host host --local-port 55432
[ "$RUN_RC" -eq 2 ] || fail "preflight --local-port 55432 exited $RUN_RC, expected 2"
out_has "local development" "preflight 55432 refusal"
pass "preflight --local-port 55432 exits 2 and names local development"

# --- Preflight --dry-run never invokes ssh --------------------------------
: > "$STUB_SSH_LOG"
run "$PREFLIGHT" --host host --checkout "$FIXTURE" --state-path "$STATE_PATH" \
  --dry-run
[ "$RUN_RC" -eq 0 ] || fail "preflight --dry-run exited $RUN_RC: $RUN_OUT"
[ ! -s "$STUB_SSH_LOG" ] || fail "preflight --dry-run invoked ssh"
out_has "$STATE_PATH" "preflight dry-run"
pass "preflight --dry-run does not invoke ssh and names the state path"

# --- Tunnel --dry-run defaults -------------------------------------------
run "$TUNNEL" --host host --dry-run
[ "$RUN_RC" -eq 0 ] || fail "tunnel default --dry-run exited $RUN_RC: $RUN_OUT"
out_has "ssh -N -T" "tunnel defaults"
out_has "-L 127.0.0.1:55433:127.0.0.1:55432" "tunnel defaults"
out_has "BatchMode=yes" "tunnel defaults"
out_has "ExitOnForwardFailure=yes" "tunnel defaults"
out_has "IdentitiesOnly=yes" "tunnel defaults"
out_has "StrictHostKeyChecking=yes" "tunnel defaults"
out_has "deploy@host" "tunnel defaults"
pass "tunnel --dry-run defaults carry the strict options and the 55433->55432 forward"

# --- Tunnel refuses the local development port ---------------------------
run "$TUNNEL" --host host --local-port 55432 --dry-run
[ "$RUN_RC" -eq 2 ] || fail "tunnel --local-port 55432 exited $RUN_RC, expected 2"
out_has "local development" "tunnel 55432 refusal"
pass "tunnel --local-port 55432 exits 2 with a local development message"

# --- Tunnel refuses equal local and remote ports --------------------------
run "$TUNNEL" --host host --local-port 5555 --remote-port 5555 --dry-run
[ "$RUN_RC" -eq 2 ] || fail "tunnel with equal ports exited $RUN_RC, expected 2"
out_has "must differ" "tunnel equal ports"
pass "tunnel with equal local and remote ports exits 2"

# --- Tunnel custom options ----------------------------------------------
run "$TUNNEL" --host host --user alice --identity /tmp/k \
  --known-hosts /tmp/kh --local-port 5555 --remote-port 55432 --dry-run
[ "$RUN_RC" -eq 0 ] || fail "tunnel custom --dry-run exited $RUN_RC: $RUN_OUT"
out_has "-i /tmp/k" "tunnel custom"
out_has "UserKnownHostsFile=/tmp/kh" "tunnel custom"
out_has "-L 127.0.0.1:5555:127.0.0.1:55432" "tunnel custom"
out_has "alice@host" "tunnel custom"
pass "tunnel --dry-run honors --user, --identity, --known-hosts, and both ports"

# --- Tunnel requires a host ---------------------------------------------
run "$TUNNEL" --dry-run
[ "$RUN_RC" -eq 2 ] || fail "tunnel without a host exited $RUN_RC, expected 2"
out_has "--host or CURVED_DEPLOY_HOST is required" "tunnel missing host"
pass "tunnel without a host exits 2"

printf 'agent-smoke: ok (%s checks)\n' "$CHECKS"
