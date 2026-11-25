#!/usr/bin/env bash
# Baseline runner for curved: main guard setup, install, database, check, build.
# scripts/clean-state.sh runs this with --no-install; the database step still runs.

set -euo pipefail

PROJECT_NAME="curved"
INSTALL_CMD="npm install"
DATABASE_CMD="bash scripts/db.sh"
CHECK_CMD="npm run check"
BUILD_CMD="npm run build"
# The HTTP server requires CURVED_UI_TOKEN; without it startup exits with an error.
START_CMD="npm start"

BASH_BIN="${BASH:-bash}"

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NO_INSTALL=0

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warn: %s\n' "$*" >&2
}

usage() {
  cat <<EOF
Usage:
  ./scripts/init.sh                       Install dependencies, set up the database,
                                          run checks, then build.
  ./scripts/init.sh --no-install          Skip the dependency install; still set up the
                                          database, run checks, then build.
  RUN_START_COMMAND=1 ./scripts/init.sh   Launch the start command after a green baseline.

Before the steps, it points core.hooksPath at .githooks. Steps run in order:
install, database, check, build. The database step runs even with
--no-install, since only dependency installation is skipped.

Options:
  --no-install   Skip dependency installation (used by scripts/clean-state.sh).
  -h, --help     Show this help.

Both modes print the last ten non-merge commits. A full run reads them from
gh (GitHub API); --no-install uses git log so the end-of-session gate stays
offline.

Project: $PROJECT_NAME
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-install)
      NO_INSTALL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

run_step() {
  step_name="$1"
  step_cmd="$2"

  say "==> $step_name: $step_cmd"
  if ! "$BASH_BIN" -c "$step_cmd"; then
    printf '\nFAILED: the %s step failed. Fix the cause above, then rerun ./scripts/init.sh.\n' "$step_name" >&2
    exit 1
  fi
}

print_recent_work() {
  local recent
  if [ "$NO_INSTALL" -eq 0 ] && command -v gh >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    recent="$(timeout 20 gh api "repos/:owner/:repo/commits?per_page=20" \
      --jq '[.[] | select((.parents | length) < 2)][0:10][] | "\(.sha[0:7]) \(.commit.message | split("\n")[0])"' 2>/dev/null || true)"
    if [ -n "$recent" ]; then
      printf '%s\n' "$recent"
      return 0
    fi
  fi

  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git rev-parse --verify HEAD >/dev/null 2>&1; then
      git log --oneline --no-merges -10
    else
      printf '%s\n' '(no commits yet)'
    fi
    return 0
  fi

  printf '%s\n' '(not a git repository and gh is unavailable)'
}

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -f .githooks/pre-push ]; then
    if [ ! -x .githooks/pre-push ]; then
      chmod +x .githooks/pre-push
    fi
    hooks_path="$(git config --get core.hooksPath || true)"
    if [ -z "$hooks_path" ]; then
      git config core.hooksPath .githooks
      say "==> git hooks: core.hooksPath=.githooks"
    elif [ "$hooks_path" = ".githooks" ]; then
      say "==> git hooks: core.hooksPath=.githooks (already set)"
    else
      warn "core.hooksPath is '$hooks_path', not .githooks; the main guard is inactive."
    fi
  else
    warn ".githooks/pre-push is missing; direct pushes to the default branch are unguarded."
  fi
fi

say "Project: $PROJECT_NAME"
say "Working directory: $PWD"
say ""
say "==> recent commits"
print_recent_work
say ""

if [ "$NO_INSTALL" -eq 0 ]; then
  run_step "install" "$INSTALL_CMD"
else
  say "==> install: skipped (--no-install)"
fi

run_step "database" "$DATABASE_CMD"
run_step "check" "$CHECK_CMD"
run_step "build" "$BUILD_CMD"

if command -v codegraph >/dev/null 2>&1 && [ -d ".codegraph" ]; then
  say "==> codegraph sync"
  if command -v timeout >/dev/null 2>&1; then
    timeout 120 codegraph sync || warn "codegraph sync failed or timed out; continuing."
  else
    codegraph sync || warn "codegraph sync failed; continuing."
  fi
fi

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  dirty_tree="$(git status --porcelain 2>/dev/null || true)"
  if [ -n "$dirty_tree" ]; then
    say "note: working tree has uncommitted changes; the baseline covers them."
  fi
fi

say ""
say "Baseline is green."
say ""
say "Next steps:"
say "  1. Read AGENTS.md for the working agreement."
say "  2. Take one work item at a time and keep this baseline green."
say "  3. Run scripts/clean-state.sh before reporting done."
say "  Start command: $START_CMD"
say "  Launch it with: RUN_START_COMMAND=1 ./scripts/init.sh"

if [ "${RUN_START_COMMAND:-0}" = "1" ] && [ "$START_CMD" != "true" ]; then
  say ""
  run_step "start" "$START_CMD"
fi
