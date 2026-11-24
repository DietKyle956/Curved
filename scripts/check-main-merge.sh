#!/usr/bin/env bash
# Fail when HEAD on a protected branch is not a merge commit.
#
# The workflow passes the pushed-from commit in GITHUB_EVENT_BEFORE. All zeros
# means the branch is being created, so the bootstrap history is allowed.
# Otherwise a commit with fewer than two parents advanced the branch directly
# and the change skipped its pull request.

set -euo pipefail

before="${GITHUB_EVENT_BEFORE:-}"

if [ "$before" = "0000000000000000000000000000000000000000" ]; then
  echo "main guard: first push to this branch; bootstrap history allowed."
  exit 0
fi

if ! commit="$(git cat-file -p HEAD)"; then
  echo "::error::main guard: cannot read HEAD."
  exit 1
fi

parents="$(printf '%s\n' "$commit" | grep -c '^parent ' || true)"

if [ "$parents" -lt 2 ]; then
  echo "::error::main guard: $(git rev-parse --short HEAD) has $parents parent(s), so it is not a merge commit. Land changes through a pull request."
  exit 1
fi

echo "main guard: HEAD is a merge commit ($parents parents)."
