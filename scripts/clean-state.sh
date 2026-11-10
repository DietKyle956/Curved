#!/usr/bin/env bash
# End-of-session gate for curved.
# Rendered by repo-init from templates/scripts/clean-state.sh; edit the template, not this file.
# The gate writes nothing; its only side effects are running the project baseline and codegraph status.
#
# Usage: ./scripts/clean-state.sh
# Exit codes: 0 when no check fails, 1 when any check fails, 2 when the repo root cannot be reached.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || {
  printf 'clean-state: cannot enter %s\n' "$REPO_ROOT" >&2
  exit 2
}

PROJECT_NAME="curved"
TODAY="$(date +%Y-%m-%d)"

SOURCE_DIRS_RAW="."
SRC_DIRS=()
for dir in $SOURCE_DIRS_RAW; do
  if [ -n "$dir" ]; then
    SRC_DIRS+=("$dir")
  fi
done

# Keep only directories that exist; fall back to the repo root when the list is empty.
SCAN_DIRS=()
if [ "${#SRC_DIRS[@]}" -gt 0 ]; then
  for dir in "${SRC_DIRS[@]}"; do
    if [ -d "$dir" ]; then
      SCAN_DIRS+=("$dir")
    fi
  done
fi
if [ "${#SCAN_DIRS[@]}" -eq 0 ]; then
  SCAN_DIRS=(".")
fi

# Directories that never hold project source or leftovers worth gating on.
PRUNE_EXPR=( \( -name .git -o -name node_modules -o -name .venv -o -name venv -o -name target -o -name dist -o -name build -o -name coverage -o -name .codegraph -o -name graphify-out \) -type d -prune )

CONFLICT_RE='^(<<<<<<<|=======|>>>>>>>)'
# Bracketed literals keep this template from matching its own patterns when
# the source directory is the repo root.
DEBUG_FAIL_RE='(^|[^[:alnum:]_])deb[u]gger([^[:alnum:]_]|$)|[.]only[(]'
DEBUG_WARN_RE='[.]skip[(]|[.]todo[(]|(^|[^[:alnum:]_])xit[(]|(^|[^[:alnum:]_])xdescribe[(]'
CG_STALE_RE='stale|out of date|outdated|needs refresh|refresh required'

FAILS=0
WARNS=0
FAIL_LIST=""
FIRST_SECTION=1

section() {
  if [ "$FIRST_SECTION" -eq 1 ]; then
    FIRST_SECTION=0
  else
    printf '\n'
  fi
  printf '==> %s\n' "$1"
}

pass() {
  printf 'PASS %s\n' "$1"
}

record_fail() {
  FAILS=$((FAILS + 1))
  printf 'FAIL %s\n' "$1"
  FAIL_LIST="${FAIL_LIST}  - $1
"
}

record_warn() {
  WARNS=$((WARNS + 1))
  printf 'WARN %s\n' "$1"
}

# Print matching lines from the configured source directories.
scan_src() {
  find "${SCAN_DIRS[@]}" "${PRUNE_EXPR[@]}" -o -type f -exec grep -nH -I -E -e "$1" {} + 2>/dev/null || true
}

section "Check 1/7: Baseline ($PROJECT_NAME scripts/init.sh --no-install)"
if [ ! -f ./scripts/init.sh ]; then
  record_fail "Baseline: ./scripts/init.sh is missing"
else
  init_out="$(bash ./scripts/init.sh --no-install 2>&1)"
  init_rc=$?
  if [ "$init_rc" -eq 0 ]; then
    pass "baseline: ./scripts/init.sh --no-install"
  else
    printf '%s\n' "$init_out" | tail -n 20
    record_fail "Baseline: ./scripts/init.sh --no-install exited $init_rc"
  fi
fi

section "Check 2/7: Temporary artifacts"
artifact_out="$(find . "${PRUNE_EXPR[@]}" -o -type f \( -name '*.tmp' -o -name '*.bak' -o -name '*.orig' -o -name '*.rej' -o -name '*.swp' -o -name '*~' \) -print 2>/dev/null || true)"
if [ -n "$artifact_out" ]; then
  printf '%s\n' "$artifact_out"
  record_fail "Temporary artifacts: remove the files listed above"
else
  pass "no temporary artifacts"
fi

section "Check 3/7: Merge-conflict markers"
conflict_out="$(scan_src "$CONFLICT_RE")"
if [ -n "$conflict_out" ]; then
  printf '%s\n' "$conflict_out"
  record_fail "Merge-conflict markers: resolve the markers listed above"
else
  pass "no merge-conflict markers"
fi

section "Check 4/7: Debug leftovers"
debug_fail_out="$(scan_src "$DEBUG_FAIL_RE")"
debug_warn_out="$(scan_src "$DEBUG_WARN_RE")"
if [ -n "$debug_fail_out" ]; then
  printf '%s\n' "$debug_fail_out"
  record_fail "Debug leftovers: remove hooks and focused tests"
else
  pass "no debug hooks or focused tests"
fi
if [ -n "$debug_warn_out" ]; then
  printf '%s\n' "$debug_warn_out"
  record_warn "Skipped tests: justify each skip marker in the report"
else
  pass "no skipped-test markers"
fi

section "Check 5/7: MEMORY.md freshness"
memory_expected="- **Last updated:** $TODAY"
if [ ! -f MEMORY.md ]; then
  record_fail "MEMORY.md: file is missing"
elif grep -qxF -e "$memory_expected" MEMORY.md 2>/dev/null; then
  pass "MEMORY.md is dated $TODAY"
else
  memory_found="$(grep -m 1 -E '^- \*\*Last updated:\*\* ' MEMORY.md 2>/dev/null || true)"
  if [ -n "$memory_found" ]; then
    printf '  found: %s\n' "$memory_found"
  else
    printf '  found: no last-updated line\n'
  fi
  printf '  want:  %s\n' "$memory_expected"
  record_fail "MEMORY.md: last-updated date is not $TODAY"
fi

section "Check 6/7: Codegraph freshness"
if [ ! -d .codegraph ]; then
  pass "no .codegraph directory"
elif ! command -v codegraph >/dev/null 2>&1; then
  record_warn "Codegraph: .codegraph exists but codegraph is not on PATH"
else
  if command -v timeout >/dev/null 2>&1; then
    cg_out="$(timeout 30 codegraph status 2>&1)"
    cg_rc=$?
  else
    cg_out="$(codegraph status 2>&1)"
    cg_rc=$?
  fi
  if [ "$cg_rc" -eq 124 ]; then
    record_warn "Codegraph: codegraph status timed out after 30s"
  elif [ "$cg_rc" -ne 0 ]; then
    printf '%s\n' "$cg_out" | tail -n 5
    record_warn "Codegraph: codegraph status exited $cg_rc"
  elif [ -z "$cg_out" ]; then
    record_warn "Codegraph: codegraph status produced no output"
  elif grep -qiE -e "$CG_STALE_RE" <<<"$cg_out"; then
    printf '%s\n' "$cg_out" | tail -n 5
    record_warn "Codegraph: graph is stale; refresh it"
  else
    pass "codegraph graph is fresh"
  fi
fi

section "Check 7/7: Working tree"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  record_warn "Working tree: not a git repository"
else
  git_out="$(git status --porcelain 2>/dev/null || true)"
  if [ -n "$git_out" ]; then
    printf '%s\n' "$git_out" | head -n 20
    record_warn "Working tree: uncommitted changes (advisory)"
  else
    pass "working tree clean"
  fi
fi

printf '\n'
if [ "$FAILS" -gt 0 ]; then
  printf 'clean-state: %d check(s) failed (%d warning(s)).\n' "$FAILS" "$WARNS"
  printf '%s' "$FAIL_LIST"
  exit 1
fi
printf 'clean-state: all checks passed (%d warning(s)).\n' "$WARNS"
exit 0
