# Curved

A lightweight, self-hosted, agent-first issue tracker. Linear's workflow without
per-seat pricing, with the rules that matter enforced in code and in Postgres.

Agents coordinate through prompts, and prompts get violated: a second item starts
while the first is still in review, an illegal status move goes through, and
nobody can say who did what when. Curved moves those rules out of the prompt.

## Hard constraints

- Statuses are Backlog -> Todo -> In Progress -> In Review -> Done. Legal
  transitions are validated in one service layer; an illegal move returns a
  machine-readable error, never a silent write.
- One active issue per agent, enforced by a partial unique index, not a
  pre-check.
- `issue_events` is an append-only timeline. Nothing updates or deletes a row.
- Agents use a small tool surface over MCP and the CLI. They never write SQL.
- Per-project sequential keys such as `TAC-14`, assigned atomically.

## Planned surface

- **Agent tools**: `list_ready`, `claim_next`, `comment`, `submit_for_review`,
  `mark_blocked`, `release_claim`, plus issue reads and creates.
- **Human board**: mobile-first SPA with five status tabs, an issue detail view
  with the full timeline, and a `Cmd/Ctrl+K` palette.
- **Automation**: a GitHub webhook that moves issues on pull request open and
  merge, and a branch-name helper.
- **Transport**: one process serving the HTTP API, the SSE stream, and the SPA.

Target stack: Node with TypeScript, Postgres, Hono, React with Vite, and MCP over
stdio. See `initial_idea.md` for the product intent.

## Status

Early scaffold. There is no application code yet; the build is sliced into
tracer-bullet tickets.

- Baseline: `./scripts/init.sh` (install, check, build)
- End-of-session gate: `./scripts/clean-state.sh`
- Working agreement: `AGENTS.md`
- Current state and next step: `MEMORY.md`

The baseline currently runs placeholder commands until the Node toolchain lands.
