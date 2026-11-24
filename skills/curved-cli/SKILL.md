---
name: curved-cli
description: >-
  Run the Curved issue tracker from a shell. Use for any Curved CLI command:
  project add/list/show/edit/archive/restore, issue
  add/list/show/comment/move/block/unblock, agent add, ready, claim, review,
  release, and git-branch, including --json output and the DATABASE_URL and
  CURVED_AGENT_TOKEN setup. For the agent work loop and MCP tools use
  curved-agent; for HTTP use curved-api.
metadata:
  source: https://github.com/DietKyle956/Curved
---

# Curved CLI

The CLI calls the same service layer as MCP and HTTP and talks to Postgres
directly, not over HTTP. It never runs SQL itself.

## Curved's rules

- Statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`.
- Legal edges: `backlog -> todo`; `todo -> backlog | in_progress`;
  `in_progress -> todo | in_review`; `in_review -> done | in_progress`;
  `done -> todo`.
- Agents may take only `todo -> in_progress` (claim an unclaimed issue),
  `in_progress -> in_review`, and `in_progress -> todo` on their own claim.
  Every other edge belongs to a human or to git.
- One active claim per agent, globally: an issue in `in_progress` or
  `in_review` claimed by you blocks a second claim with `agent_busy` naming
  that key.
- Claiming sets `claimed_by`; review keeps it. Leaving `in_progress` or
  `in_review` for `todo` or `backlog` clears it. Blocking is a reason on a
  `todo` issue, not a status, and blocked issues never appear in the ready
  queue.
- Agent-only actions: claim, review, release, block. Human-only actions:
  unblock, arbitrary moves, issue edits, labels, relations, project
  create/edit/archive. Git-only edge: `in_review -> done` on a merged pull
  request.

## Setup

- Node 26.2 or newer and a checkout of the Curved repository.
- Every database-backed command (everything except `help`) needs
  `DATABASE_URL`, for example
  `postgres://<user>:<password>@<host>:<port>/<database>`. The database must be
  reachable from the machine running the CLI: local Compose (`npm run db`) or
  an operator-provided route. Never assume a public Postgres port.
- `ready`, `claim`, `review`, `release`, and `issue block` need
  `CURVED_AGENT_TOKEN` set to a `crv_` token minted by
  `curved agent add <name>`. Only the hash is stored, so the token is shown
  once.
- Commands below use `curved`. From a checkout without an installed wrapper,
  replace it with `node src/composition/cli.ts` (or `npm run cli -- ...`).
- Usage errors exit 2 with the usage text; service errors exit 1 with
  `code: message` on stderr; success exits 0. `--json` may appear anywhere and
  prints machine-readable JSON on stdout.

## Projects (human actor)

- `project add <KEY> <name...> [--summary <text>] [--description <text>]
  [--status <status>] [--priority <1-4>] [--start <date>] [--target <date>]`
  creates a project. The name is positional, not `--name`. The key matches
  `^[A-Z][A-Z0-9]{1,9}$` and never changes. Status defaults to `planned`;
  priority, start, and target default to empty. Summary is at most 255
  characters; description is at most 20000; dates are strict `YYYY-MM-DD` and
  must be real calendar dates.
- `project list [--all]` lists active projects ordered by key; `--all` includes
  archived. Row columns are tab-separated:
  `key name status priority done/total target archived`, with `-` for an empty
  priority or target and `no`/`yes` for archived.
- `project show <KEY>` prints `key` and `name` on the first line, then
  `status`, `priority`, `start`, `target`, `progress`, `archived`, `summary`,
  and `description` lines.
- `project edit <KEY> [--name <name>] [--summary <text>]
  [--description <text>] [--status <status>] [--priority <1-4|none>]
  [--start <date|none>] [--target <date|none>]`. `none` clears priority or a
  date. Any of the six project statuses is legal at any time.
- `project archive <KEY>` sets `archived_at`; `project restore <KEY>` clears
  it. There is no project delete. Archived projects stay readable and their
  issues stay writable.

## Issues

- `issue add <PROJECT> <title...> [--description <text>] [--priority <1-4>]
  [--status <status>] [--parent <KEY>]` creates an issue. Title is trimmed to
  1..500; status defaults to `backlog`; priority defaults to 3; `--status todo`
  is what makes an issue claimable; a parent must be in the same project.
- `issue list [PROJECT]` prints tab-separated
  `key status priority title blocked_reason`, with `-` for no reason.
- `issue show <KEY>` prints `key`, `status`, `priority`, `title`,
  `description`, `parent`, `children` and one indented row per child,
  `labels`, `blocks`, `blocked_by`, `blocked_reason`, `claimed_by`,
  `created_at`, `updated_at`, then `timeline:` and one row per event as
  `id kind actor_type created_at body` with `-` for a null body.
- `issue comment <KEY> <body...> [--actor <agent|human|git|system>]
  [--agent <name>]` appends a comment event. The default actor is `human`; the
  body is trimmed and must not be empty.
- `issue move <KEY> <status> [--body <text>] [--actor <agent|human|git|system>]
  [--agent <name>]` takes only a legal edge and only an edge the actor may
  take. The default actor is `human`; an agent actor may take only the three
  agent edges and only on its own claim.
- `issue block <KEY> <reason...>` is agent-only and needs
  `CURVED_AGENT_TOKEN`. It requires the caller's `in_progress` claim; the
  trimmed reason is 1..2000; the issue returns to `todo`, the claim clears, and
  a `blocked` event is appended.
- `issue unblock <KEY> [--actor ...] [--agent ...]` is human-only; it clears
  the reason and appends `unblocked`, leaving status and claim untouched.

The CLI does not authenticate the human actor. Never pass `--actor human` to
take an edge the agent matrix forbids.

## Agent commands

- `agent add <name>` prints `created agent <name>` and
  `token: crv_...` once; only the SHA-256 hash is stored. The name is trimmed
  to 1..100 characters. `--json` includes `token`.
- `ready [PROJECT] [--human]` prints ready rows as
  `key priority status title`, then `busy: <key|->`. `--human` lists without an
  agent token and reports `busy: -`.
- `claim [PROJECT]` claims the next ready issue; errors are `agent_busy` and
  `no_ready_issue`.
- `review <KEY> <summary...>` submits the caller's `in_progress` claim for
  review; the summary is non-empty and becomes the review event body.
- `release <KEY>` returns the caller's `in_progress` claim to `todo` and clears
  the claim.

## Git branch

`git-branch <KEY> [--json]` prints `<KEY>-<slug>`. The slug is the lowercased
title with every run of non-alphanumeric characters replaced by `-`, leading
hyphens removed, truncated to 60 characters, and trailing hyphens removed; an
empty slug leaves the key alone.

## Migrations

`migrate` applies pending migrations and prints their names, or
`already up to date`.

## Errors and fixes

|Code|Fix|
|---|---|
|`not_authenticated`|Set `CURVED_AGENT_TOKEN` to a valid `crv_` token.|
|`agent_busy`|Finish or release the named active issue first.|
|`no_ready_issue`|Nothing is claimable; stop or create work.|
|`illegal_transition`|The requested edge is not legal from the current status.|
|`forbidden_transition`|The edge is legal, but this actor or claim may not take it.|
|`not_found`|The project, issue, or parent key does not exist.|
|`validation`|Check the key, title, priority, date, or length.|
|`duplicate`|The agent name or project key already exists.|

## Completion check

- The correct actor is used and the token is set for agent verbs.
- The requested status move is legal from the current status.
- `--json` is used when another program parses the output.
- The actual command output was inspected, not assumed.
