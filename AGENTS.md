# AGENTS.md

`curved`: a lightweight, agent-first issue tracker (a Linear the agents can drive).
Read this file, `MEMORY.md`, and `initial_idea.md` before writing code.

## Product constraints (hard)

The value is the state machine and the API, not the UI. Enforce these in code, never
in prompts:

- Statuses: Backlog -> Todo -> In Progress -> In Review -> Done. Legal transitions are
  validated in the service layer; illegal ones return an error, not a silent write.
- One active issue per agent (`in_progress` or `in_review`, global across
  projects), enforced by a partial unique index. An agent cannot claim another
  issue until its current one is done or released.
- `issue_events` is append-only status history. Never update or delete rows.
- Agents use the tool interface only (`list_ready`, `claim_next`, `comment`,
  `submit_for_review`, `mark_blocked`). No agent writes SQL or touches tables.
- Per-project sequential IDs (`TAC-014` style), assigned atomically.

## Startup workflow

1. `pwd` to confirm the repo root.
2. Read `MEMORY.md` for verified state and the next step.
3. `./scripts/init.sh` to prove the baseline.
4. If the baseline is red, fix that before adding features.

## Current state

The Node/TypeScript toolchain is live: `npm install`, typechecking for the server and
web trees, tests, and the build all run today. Postgres 18 runs through
`docker compose` on host port 55432, with `scripts/db.sh` bootstrapping the database
and applying migrations. The projects and issues resources ship with CLI commands:
`project add` and `project list`, plus `issue add`, `issue list`, `issue show`,
`issue comment`, and `issue move`. Keys are allocated atomically per project, and
every issue carries an append-only `issue_events` timeline. Comments are timeline
events, not rows in a separate table: `issue comment` appends one, and `issue show`
renders the full timeline in ascending event order. The LAS-144 status machine is
live: one shared transition graph, an actor matrix gating which legal edges each
actor type may take, claim-column rules tied to agent moves, the `issue move` CLI
command, and `allowedTransitions` on every issue payload. LAS-145 is live: an
`agents` table with hashed tokens, token-authenticated `ready`, `claim`, `review`,
and `release` commands, `claim` and `review_submitted` events, and the partial
unique claim fence (`issues_one_active_claim_per_agent`) that allows one active
issue per agent globally. LAS-146 is live: `issue block` records a 1..2000 character
reason, returns the issue to Todo, clears the claim, and appends a `blocked` event;
`issue unblock` is human only, clears the reason, and appends `unblocked`; blocked
issues are absent from `ready` and unclaimable. LAS-147 is live: MCP-over-stdio
(`npm run mcp`, `node src/mcp/main.ts`) exposes the eight tools (`claim_next`,
`comment`, `create_issue`, `get_issue`, `list_ready`, `mark_blocked`,
`release_claim`, `submit_for_review`) over the shared service layer, resolving the
agent from `CURVED_AGENT_TOKEN` on every call. LAS-148 is live: an HTTP API and
auth boundary (`npm start`, `node src/server.ts`) on `PORT` (default 4747) that
requires `CURVED_UI_TOKEN`, authenticates humans by UI bearer or the
`curved_session` cookie (SHA-256 of the UI token) and agents by `crv_` bearer,
and serves `/api/me`, `/api/session`, projects, issues (list with `project` and
`status` filters, create, show, human-only `PATCH`), per-issue transition,
comments, block (agent), unblock (human), release (agent), `/api/ready`, and
`/api/claims/next`. Errors are `{ error: { code, message } }` with 400 validation,
401 `not_authenticated`, 403 `forbidden_transition`, 404 `not_found`, 409 for the
other service codes, and 500 internal. There is no CORS, mutating requests with a
body must be JSON, and non-`/api` paths fall back to `web/dist` with no-cache
documents, immutable `/assets/*`, and a 503 naming the build when it is absent.
LAS-149 is live: migration `0004` adds project-scoped `labels`, `issue_labels`, and
`issue_relations`; the label and relation services write the `labels` and
`relation` event kinds; human-only HTTP routes replace an issue's label set and
add a blocking relation; issue payloads carry `labels` and `relations` with
`blocks` and `blockedBy`; and `ready` and claim skip issues whose blocking
relation is not Done.
Tests: 154 pass, 0 fail, including `test/http.test.ts`, the label and relation
suites in `test/labels.test.ts` and `test/relations.test.ts`, and the issue filter
and human-only edit cases in `test/issues.test.ts`. Next frontier: LAS-150 and
LAS-151.

## Directory page

| Path | Role |
|---|---|
| `initial_idea.md` | Product intent and the design sketch. Source of truth for scope. |
| `AGENTS.md` | This file: constraints and startup path. |
| `MEMORY.md` | Verified state, decisions, session log. Update it every session. |
| `src/http/` | HTTP router, auth boundary, and SPA fallback. |
| `src/server.ts` | HTTP entry. Reads `PORT` and requires `CURVED_UI_TOKEN`. |
| `scripts/init.sh` | Baseline runner: install, check, build. `--no-install` skips install. |
| `scripts/clean-state.sh` | End-of-session gate. Idempotent, writes nothing. |
| `.codegraph/` | Local index, gitignored. Refresh with `codegraph sync`. |

## Working rules

- One work item at a time; keep the tree restartable from `./scripts/init.sh`.
- Prefer boring, explicit code over abstraction. Type the boundaries.
- Do not silently relax a verification rule mid-implementation.
- Record durable state in `MEMORY.md`, not in chat.
- Push every completed work item to `origin/main` before reporting success. An
  unpushed commit is not finished work.

## Definition of done

- Behavior implemented and exercised through its real entry point (HTTP route, MCP
  tool, or UI), not only a unit test.
- The state-machine or permission invariant the change touches is proven by a test
  that would fail without the change.
- `./scripts/init.sh` green, `./scripts/clean-state.sh` green.
- `MEMORY.md` dated today with what changed and the next step.

## End of session

1. Update `MEMORY.md`: `- **Last updated:** <today>` plus the session entry.
2. Note unresolved risk or blockers explicitly.
3. Run `./scripts/clean-state.sh`.
4. Commit the work and push `main` to `origin`; report success only once
   `git ls-remote origin main` matches local `HEAD`.
