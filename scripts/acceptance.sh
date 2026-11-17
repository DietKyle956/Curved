#!/usr/bin/env bash
# Repeatable end-to-end acceptance gate for the non-browser entry points.
# Boots Postgres, makes sure the SPA is built, then hands off to the Node
# orchestrator. Every leg runs against a throwaway database, so the local
# `curved` database rows are never touched: Postgres is started without
# applying migrations to it (`db.sh --no-migrate`), because the orchestrator
# migrates the throwaway database itself and captures its safety digests of
# the default database before any schema write.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/db.sh --no-migrate

# Always rebuild: the browser leg must exercise the SPA built from the tree
# under test, never a stale web/dist left over from an earlier build.
printf 'acceptance: building the web app into web/dist\n'
npm run build:web

exec node scripts/acceptance.mjs "$@"
