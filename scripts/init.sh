#!/usr/bin/env bash
# Baseline runner for curved.
# Rendered by repo-init from templates/scripts/init.sh; edit the template, not this file.

set -euo pipefail

PROJECT_NAME="curved"
INSTALL_CMD="true"
CHECK_CMD="true"
BUILD_CMD="true"
START_CMD="true"

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
  ./scripts/init.sh                       Install dependencies, run checks, build.
  ./scripts/init.sh --no-install          Skip install; run checks and build.
  RUN_START_COMMAND=1 ./scripts/init.sh   Launch the start command after a green baseline.

Options:
  --no-install   Skip dependency installation (used by scripts/clean-state.sh).
  -h, --help     Show this help.

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

say "Project: $PROJECT_NAME"
say "Working directory: $PWD"
say ""

if [ "$NO_INSTALL" -eq 0 ]; then
  run_step "install" "$INSTALL_CMD"
else
  say "==> install: skipped (--no-install)"
fi

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
