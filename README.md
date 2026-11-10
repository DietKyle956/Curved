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

The toolchain is live: Node 26.2 runs the TypeScript directly via type stripping,
Postgres 18 runs through `docker compose` on host port 55432, migrations create and
update the schema, and the projects and issues resources ship with CLI commands.
Issue keys such as `TAC-14` are allocated atomically per project, and every issue
carries an append-only `issue_events` timeline. Comments are append-only timeline
events of their own, not rows in a separate comments table; there is no comments
table and no migration for one. `issue show` renders the full timeline for an issue,
so comments appear there alongside status events.

The status machine is live. Legal moves are the edges of one graph: `backlog` ->
`todo`; `todo` <-> `backlog` and `todo` <-> `in_progress`; `in_progress` <-> `todo`
and `in_progress` <-> `in_review`; `in_review` <-> `in_progress` and `in_review` ->
`done`; `done` -> `todo`. A separate actor matrix gates which of those edges each
actor type may take: `human` may take any legal edge; `agent` may claim an unclaimed
`todo` issue by moving it to `in_progress` with a named agent, and after that may
only take `in_progress` -> `in_review` or `in_progress` -> `todo` on an issue it
owns; `git` may take `in_progress` -> `in_review` and `in_review` -> `done`. The
claim column is set when an agent claims an issue into `in_progress`, kept for
`in_review` and `done`, and cleared when the issue moves to `todo` or `backlog`.
Every issue payload carries `allowedTransitions`: the successors the requesting
actor may take right now.

- `node src/cli.ts issue add <PROJECT> <title...>` - create an issue; keys are
  assigned atomically.
- `node src/cli.ts issue list [PROJECT]` - list issues, optionally scoped to one
  project.
- `node src/cli.ts issue show <KEY>` - print the issue and its timeline in ascending
  event order.
- `node src/cli.ts issue comment <KEY> <body...> [--actor <type>]` - append a comment
  event to the timeline.
- `node src/cli.ts issue move <KEY> <status> [--body <text>] [--actor <type>]
  [--agent <name>]` - move an issue along a legal edge for the given actor.
- `npm run db` - start Postgres and apply migrations.
- `./scripts/init.sh` - install, database, check, build.
- `./scripts/clean-state.sh` - end-of-session gate.
- `npm test` - tests run against the isolated `curved_test` database.
- Working agreement: `AGENTS.md`
- Current state and next step: `MEMORY.md`
