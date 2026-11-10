# AGENTS.md

`curved`: a lightweight, agent-first issue tracker (a Linear the agents can drive).
Read this file, `MEMORY.md`, and `initial_idea.md` before writing code.

## Product constraints (hard)

The value is the state machine and the API, not the UI. Enforce these in code, never
in prompts:

- Statuses: Backlog -> Todo -> In Progress -> In Review -> Done. Legal transitions are
  validated in the service layer; illegal ones return an error, not a silent write.
- One `in_progress` issue per project/agent, enforced by a partial unique index.
- An agent cannot claim a new issue until its current one passes review.
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
command, and `allowedTransitions` on every issue payload. Next frontier: LAS-145.

## Directory page

| Path | Role |
|---|---|
| `initial_idea.md` | Product intent and the design sketch. Source of truth for scope. |
| `AGENTS.md` | This file: constraints and startup path. |
| `MEMORY.md` | Verified state, decisions, session log. Update it every session. |
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
