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

Agent identities live in an `agents` table. `agent add <name>` mints a `crv_`
token, prints it once, and stores only its SHA-256 hash. Agent commands
authenticate with `CURVED_AGENT_TOKEN` and fail with `not_authenticated` when it
is absent or invalid. `ready` lists unblocked `todo` issues ordered by priority
then number, together with the caller's busy key. `claim` takes one issue with
`for update skip locked` and writes a `claim` event; `review` writes
`review_submitted`; `release` returns the issue to `todo`. The partial unique
index `issues_one_active_claim_per_agent` fences one active issue (`in_progress`
or `in_review`) per agent globally, across projects, and the service maps a
violation to `agent_busy`. Another agent's claimed issue is off limits for
transitions and comments.

Blocking is a reason plus `todo`, not a sixth status. The owning agent blocks a
claimed issue with a reason of 1 to 2000 characters; blocking returns the issue
to `todo`, clears the claim, stores the reason in `blocked_reason`, and appends a
`blocked` event to the timeline. Only a human may unblock: that clears the reason
and appends an `unblocked` event, leaving status and claim untouched. A blocked
issue is absent from `ready` and cannot be claimed until it is unblocked.

The authenticated HTTP boundary is live. `npm start` runs `node src/server.ts` on
`PORT` (default 4747) and refuses to start without `CURVED_UI_TOKEN`. Requests
authenticate as a human through the session cookie or the UI bearer token, or as
an agent through a `crv_` bearer token; failures and service errors share one JSON
error shape, and there is no CORS. The API covers projects, issues, comments,
transitions, block/unblock, release, and claims, and serves the SPA from
`web/dist` for every non-`/api` path. See "HTTP API" below.

- `node src/cli.ts issue add <PROJECT> <title...>` - create an issue; keys are
  assigned atomically.
- `node src/cli.ts issue list [PROJECT]` - list issues, optionally scoped to one
  project; the fifth column is the blocked reason or `-`.
- `node src/cli.ts issue show <KEY>` - print the issue and its timeline in ascending
  event order.
- `node src/cli.ts issue comment <KEY> <body...> [--actor <type>]
  [--agent <name>]` - append a comment event to the timeline.
- `node src/cli.ts issue move <KEY> <status> [--body <text>] [--actor <type>]
  [--agent <name>]` - move an issue along a legal edge for the given actor.
- `node src/cli.ts issue block <KEY> <reason...>` - block a claimed issue with a
  reason; returns it to `todo`, clears the claim, and appends a `blocked` event;
  requires `CURVED_AGENT_TOKEN`.
- `node src/cli.ts issue unblock <KEY> [--actor <type>] [--agent <name>]` - clear
  a blocked issue's reason and append an `unblocked` event; humans only.
- `node src/cli.ts agent add <name>` - create an agent; prints its `crv_` token
  once, and only the SHA-256 hash is stored.
- `node src/cli.ts ready [PROJECT] [--human]` - list unblocked `todo` issues by
  priority then number, with the caller's busy key; requires
  `CURVED_AGENT_TOKEN` unless `--human` is passed.
- `node src/cli.ts claim [PROJECT]` - claim the next ready issue with
  `for update skip locked`; requires `CURVED_AGENT_TOKEN`.
- `node src/cli.ts review <KEY> <summary...>` - submit a claimed issue for
  review; requires `CURVED_AGENT_TOKEN`.
- `node src/cli.ts release <KEY>` - return a claimed issue to `todo`; requires
  `CURVED_AGENT_TOKEN`.
- `npm run db` - start Postgres and apply migrations.
- `npm start` - run the HTTP server and SPA on `PORT` (default 4747); requires
  `CURVED_UI_TOKEN`.
- `./scripts/init.sh` - install, database, check, build.
- `./scripts/clean-state.sh` - end-of-session gate.
- `npm test` - tests run against the isolated `curved_test` database.
- Working agreement: `AGENTS.md`
- Current state and next step: `MEMORY.md`

## HTTP API

`node src/server.ts` (or `npm start`) serves the JSON API under `/api` and the SPA
for every other path. One process owns both.

Prerequisites:

1. Postgres: `docker compose up -d`.
2. Schema: `npm run migrate`.
3. A UI token: export any secret as `CURVED_UI_TOKEN`. The server refuses to start
   without it and exits 1 with
   `CURVED_UI_TOKEN is required to start the HTTP server`.
4. Agent tokens for `crv_` bearers: `node src/cli.ts agent add <name>`.

`PORT` defaults to 4747.

Authentication has two lanes. A human session is either
`Authorization: Bearer <CURVED_UI_TOKEN>` or the `curved_session` cookie minted by
`POST /api/session`. The cookie is the lowercase SHA-256 hex of the UI token and is
`HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`. Any other bearer is resolved as
an agent token through the `agents` table. A bearer that is present but invalid is
`401 not_authenticated`, even alongside a valid cookie, so a stale agent token is
never silently downgraded.

`POST /api/session` is the only unauthenticated `/api` route; every other route,
including `GET /api/projects`, rejects requests without valid credentials with
`401 not_authenticated`.

| Method | Path | Auth | Result |
|---|---|---|---|
| `GET` | `/api/me` | human or agent | `{ actor }` |
| `POST` | `/api/session` | UI token in the `{ token }` body | Sets the cookie, returns `{ actor }` |
| `DELETE` | `/api/session` | human or agent | `204`, clears the cookie |
| `GET` | `/api/projects` | human or agent | `{ projects }` |
| `POST` | `/api/projects` | human only | `{ project }` |
| `GET` | `/api/issues` | human or agent | `{ issues }`; optional `project` and `status` filters |
| `POST` | `/api/issues` | human or agent | `{ issue }` |
| `GET` | `/api/issues/:key` | human or agent | `{ issue, events }` |
| `PATCH` | `/api/issues/:key` | human only | `{ issue }`; `title`, `description`, `priority` |
| `POST` | `/api/issues/:key/transition` | human or agent | `{ issue }` |
| `POST` | `/api/issues/:key/comments` | human or agent | `{ event }` |
| `POST` | `/api/issues/:key/block` | agent only | `{ issue }` |
| `POST` | `/api/issues/:key/unblock` | human only | `{ issue }` |
| `POST` | `/api/issues/:key/release` | agent only | `{ issue }` |
| `GET` | `/api/ready` | human or agent | `{ ready, busy }` |
| `POST` | `/api/claims/next` | agent only | `{ issue }` |

Mutating requests with a body must send `Content-Type: application/json`; anything
else is `400 validation`. An empty body reads as `{}`. The API sends no CORS
headers, so browser clients run on the same origin.

Errors share one shape, `{ "error": { "code", "message" } }`. `validation` maps to
400, `not_authenticated` to 401, `forbidden_transition` to 403, `not_found` to
404, the remaining service codes such as `agent_busy`, `duplicate`, and
`illegal_transition` to 409, and an unexpected failure to 500 with the detail
logged to stderr. An unknown `/api` path returns a JSON 404 and never falls back to
HTML.

Everything outside `/api` is served from `web/dist`: a matching file, otherwise
`index.html` for client-side routes. The document is `cache-control: no-cache`;
`/assets/*` is `public, max-age=31536000, immutable`. When no build exists the
response is a 503 text naming `web/dist` and the build command.

## MCP server (stdio)

The MCP server speaks JSON-RPC over stdio and calls the same service layer as the
CLI. It never runs SQL itself.

Prerequisites:

1. Postgres: `docker compose up -d`.
2. Schema: `npm run migrate`.
3. An agent identity: `node src/cli.ts agent add <name>` prints a `crv_` token
   once. Export it as `CURVED_AGENT_TOKEN`; only its hash is stored, so save it.

Start the server with `npm run mcp`, which is `node src/mcp/main.ts`. stdout
belongs to the JSON-RPC protocol; logs go to stderr. Writing anything else to
stdout corrupts the stream.

Harness config example:

```json
{
  "mcpServers": {
    "curved": {
      "command": "node",
      "args": ["/absolute/path/to/curved/src/mcp/main.ts"],
      "env": {
        "DATABASE_URL": "postgres://curved:curved@localhost:55432/curved",
        "CURVED_AGENT_TOKEN": "crv_..."
      }
    }
  }
}
```

Every call resolves the agent from `CURVED_AGENT_TOKEN` and acts as actor
`agent` under that agent's name. Tools:

| Tool | Input | Result |
|---|---|---|
| `claim_next` | `{ project? }` | Claims the next ready issue, then returns `{ issue, events }`. |
| `comment` | `{ key, body }` | Appends a comment event and returns it. |
| `create_issue` | `{ project, title, description?, priority? }` | Returns the created issue. |
| `get_issue` | `{ key }` | Returns `{ issue, events }`. |
| `list_ready` | `{ project? }` | Returns `{ ready, busy }`. |
| `mark_blocked` | `{ key, reason }` | Blocks the issue and returns it. |
| `release_claim` | `{ key }` | Returns the issue to Todo and returns it. |
| `submit_for_review` | `{ key, summary }` | Submits the issue for review and returns it. |

Successful results are the payload as pretty-printed JSON in a single text
content block. A service error becomes a text block of `<code>: <message>` with
`isError: true`, for example `not_authenticated: ...` or `agent_busy: ...`.
Invalid tool input fails zod validation before the handler runs and comes back as
an error result: `Input validation error: Invalid arguments for tool <name>: ...`.
