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
(`npm run mcp`, `node src/composition/mcp.ts`) exposes the eight tools (`claim_next`,
`comment`, `create_issue`, `get_issue`, `list_ready`, `mark_blocked`,
`release_claim`, `submit_for_review`) over the shared service layer, resolving the
agent from `CURVED_AGENT_TOKEN` on every call. LAS-148 is live: an HTTP API and
auth boundary (`npm start`, `node src/composition/server.ts`) on `PORT` (default
4747) that requires `CURVED_UI_TOKEN`, authenticates humans by UI bearer or the
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
LAS-150 is live: migration `0005` adds notification triggers that `pg_notify` the
owning project id on issue insert/update and issue-event insert;
`src/adapters/postgres/event-hub.ts` owns one lazily opened shared `pg.Client` per
app running `LISTEN issues_changed`, fans numeric project ids out to subscribers,
and reconnects once after 1s while subscribers remain; `GET /api/events` is a
cookie-only `text/event-stream` (`ready`, `issues_changed` with the project id as
`data`, and a 25 second `ping`) authenticated by the `curved_session` cookie
because `EventSource` cannot set headers, so a bearer-only request is `401`;
`createApp` then required `databaseUrl` and owned the hub unless one was injected;
`src/adapters/http/transport.ts` streams event-stream responses chunked with
backpressure and aborts each request's signal on client disconnect; and the SPA's
20 second poll is replaced by one `EventSource` that reconnects after 1s, filters
by project, and refreshes the board and open issue detail.
The SPA prototype is live in `web/`: Vite + React + Tailwind v4 built into
`web/dist`, served by the HTTP process. It covers sign-in with the UI token,
first-run project setup, a five-lane board with drag transitions gated by
`allowedTransitions`, the ready queue with in-flight agents and human unblock,
issue detail with timeline, comments, edits, labels, and blocking relations, and a
`Ctrl/Cmd+K` palette. The warm near-black palette is fixed; there is no light
mode. `npm run dev` proxies `/api` to 4747 for development. LAS-151 is live:
`POST /webhooks/github` verifies the `x-hub-signature-256` HMAC of the raw body
against `GITHUB_WEBHOOK_SECRET` before parsing, moves `pull_request` `opened` and
`reopened` events to In Review and `closed` events with a merged pull request to
Done as the `git` actor with a `pull request #<n> <action>` status event, answers
`200 {"ok":true,"ignored":true}` for unknown keys, illegal transitions, replays,
and non-PR events so GitHub never retries, and
`node src/composition/cli.ts git-branch <KEY>` prints the canonical branch name.
LAS-152 is live: the hand-rolled history router (`web/src/lib/router.ts`) parses
`/`, `/p/<KEY>`, `/p/<KEY>/queue`, `/p/<KEY>/i/<ISSUE>`, and `/new` or
`/p/<KEY>/new`, writes history with `pushState`/`replaceState`, listens
to `popstate`, and dispatches a `navigate` `CustomEvent` (`{ path, replace }`) for
every one; the new-issue dialog is route-driven, so direct loads, browser Back, and
the create redirect all agree. The board switches to five horizontally scrollable
columns at 900 px (the `lg` breakpoint token is overridden to 900 px) and below that
shows a card list with a sticky five-status tab bar above the shell nav, 44 px
targets, and per-status counts derived client-side from the single `GET /api/issues`
fetch. Cards carry key, title, a priority dot, label chips, a blocked badge, and
claimer initials. The ticket's light/dark `prefers-color-scheme`, system-font, and
8 px-spacing clause is a deliberate deviation: the warm near-black palette is fixed,
there is no light mode, and the fonts are self-hosted (no CDN).
LAS-169 is live: step 2 of the `ARCH.md` refactor extracts the pure domain into
`src/domain/`. `status.ts` owns the status, priority, event-kind, and actor-type
contract plus its defaults; `transition.ts` owns the legal edge graph
(`TRANSITIONS`, `LEGAL_EDGES`); `actors.ts` owns the actor matrix, actor-context
resolution, and `allowedTransitions`; `claim.ts` owns `nextClaimedBy`;
`move-policy.ts` owns `mayMove`; `validation.ts` owns every validator and
max-length constant; `keys.ts` owns key parsing and branch naming; `errors.ts`
owns `ServiceError` and `ERROR_CODES`; and `types.ts` owns the shared record
types. At that point the services kept the SQL for the resources not yet
migrated, the issue read model, and orchestration, and imported every pure rule
from the domain; `src/services/` has since been retired by `LAS-170` to
`LAS-173`. The HTTP status mapping (`HTTP_STATUS`, `httpStatusFor`) lives in
`src/adapters/http/errors.ts`. The old shared status module and the old root error
module are deleted. Behavior is unchanged; the baseline stays green.
LAS-170 is live: step 3's first slice adds `src/application/ports.ts`
(`ProjectRepository`, `TokenCodec`, `ActiveClaimConflict`, `Ports`,
`TransactionPorts`), `src/application/projects.ts` (create and list use cases with
no SQL), `src/adapters/postgres/ports.ts` (`createPorts`, flat transactions over
`Database.tx`), `src/adapters/postgres/repositories/projects.ts` (ordered list,
find by key, `23505` to `duplicate`), and `src/adapters/token-codec.ts`;
`src/services/projects.ts` is deleted, the HTTP app takes a required `ports`
aggregate, the CLI builds ports, and the agent token helpers use the codec.
Behavior is unchanged: 189 tests pass.
LAS-171 is live: the issue lifecycle and read model sit on ports.
`src/application/issues.ts` holds `createIssue`, `listIssues`, `getIssue`,
`getIssueTimeline`, `updateIssue`, and `moveIssue` with no SQL;
`src/application/issue-read-model.ts` holds `toIssue` (which derives
`allowedTransitions`) and `hydrateIssue`. `src/application/ports.ts` adds
`IssueRecord`, `LockedIssueRecord`, `IssueRepository` (create with atomic
per-project allocation, find by id, find by key, lock by key, list, update
fields, update status, find the active claim key, list ready),
`IssueEventRepository`, `IssueMetaRepository` (at most two statements), and
`AgentRepository.exists`, and `TransactionPorts` carries projects, issues,
events, meta, agents, and tokens. They are implemented in
`src/adapters/postgres/repositories/issues.ts`, `issue-events.ts`,
`issue-meta.ts`, and `agents.ts`, and `src/adapters/postgres/ports.ts` exports
`bindPorts` (`createPorts` delegates to it). `src/services/issues.ts`,
`src/services/events.ts`, and `src/services/issue-meta.ts` are deleted. The
then-transitional services (`queue.ts`, `blocking.ts`, `comments.ts`, `labels.ts`,
`relations.ts`, `github.ts`) bound ports for shared work while their own SQL
stayed in `src/services/` until LAS-172 (queue and blocking) and LAS-173 (labels
and relations); that directory is now deleted.
The HTTP issue routes, the webhook, the CLI issue commands and `git-branch`, and
MCP `ToolDeps` all pass `ports`. A violation of the
`issues_one_active_claim_per_agent` constraint surfaces as `ActiveClaimConflict`
and keeps the `agent_busy` message naming the active key. Behavior is unchanged:
189 tests pass.
LAS-172 is live: step 3's third slice moves the rest of the shared services onto
ports. `src/application/agents.ts` holds `createAgent`, `authenticateAgent`, and
`ensureAgentExists` (token mint and hash go through `TokenCodec`),
`src/application/queue.ts` holds `ReadyQueue`, `listReady`, `claimNext`,
`submitForReview`, and `releaseClaim`, `src/application/blocking.ts` holds
`blockIssue` and `unblockIssue`, and `src/application/comments.ts` holds
`commentOnIssue`, none with SQL and none importing `pg`. `AgentRepository` in
`src/application/ports.ts` becomes `create({ name, tokenHash })`, `findByTokenHash`,
`findByName`, and `acquireClaimLock(name)`, with the old `exists` gone, and
`IssueRepository` adds `block({ id, reason })`, `unblock({ id })`, and
`lockClaimCandidate({ project })` (todo, unblocked, no not-done blocker,
priority/number/key order, `for update ... skip locked`), while `updateStatus`,
`findActiveClaimKey`, and `listReady` are unchanged. They are implemented in
`src/adapters/postgres/repositories/agents.ts`, which maps SQLSTATE `23505` to
`ServiceError("duplicate", 'agent "<name>" already exists')` and owns the
advisory lock `select pg_advisory_xact_lock(727275, hashtext($1))`, and in
`src/adapters/postgres/repositories/issues.ts`, which owns the skip-locked
candidate query and the single-statement block and unblock updates.
`src/services/agents.ts`, `queue.ts`, `blocking.ts`, and `comments.ts` are
deleted, leaving `labels.ts`, `relations.ts`, and `github.ts` for LAS-173. HTTP
auth resolves the actor with `resolveActor(request, { ports, uiToken })` and the
comment, block, unblock, release, ready, and claim routes take `ports` (`db`
then remained for labels, relations, and the event hub), the CLI builds
`createPorts(db)` once per `withDatabase` scope and wraps work in
`withAgent(ports, config, fn)`, and MCP `ToolDeps` is ports-only
(`{ ports, resolveAgent }`) with `resolveAgentFromToken(ports, config)`.
Behavior, error codes, messages, and concurrency semantics are unchanged: 189
tests pass.
LAS-173 is live: step 3's fourth and final slice puts labels, relations, and the
GitHub use case on ports, and `src/services/` is deleted with no re-export shims.
`src/application/ports.ts` adds `LabelRepository`
(`replace({ issueId, projectId, names })`, the project-scoped label upsert plus
set replacement) and `RelationRepository` (`add({ blockingIssueId,
blockedIssueId })`, an idempotent insert that resolves true only when a row was
created), and `TransactionPorts` carries `labels` and `relations`.
`src/application/labels.ts` holds `setIssueLabels(ports, input)`,
`src/application/relations.ts` holds `addRelation(ports, input)`, and
`src/application/github.ts` holds `applyPullRequestEvent(ports, event, payload)`,
none importing `pg`, `src/db.ts`, or `node:*`. They are implemented in
`src/adapters/postgres/repositories/labels.ts` (`createLabelRepository`, the same
three statements) and `relations.ts` (`createRelationRepository`, the same
idempotent insert), both wired in `bindPorts`. `src/adapters/http/webhook.ts` keeps
HMAC verification, the raw-body read, the 1 MiB body cap, JSON parsing, and the
non-POST 404, and now calls the use case. `createApp` no longer accepts a `db`
option: the label and relation routes take `ports`, `src/composition/server.ts` and
six test files were updated, and the test changes are imports, `testDb.db` to
`testDb.ports`, and removed `db` options only, so no assertion moved. Behavior is
unchanged: 189 tests pass.
LAS-174 is live: step 4 of the `ARCH.md` refactor plus the step-6 import-direction
gate. Inbound adapters moved under `src/adapters/` (`http/`, `mcp/`, `cli/`,
`github/`, `sse/`, `static/`) and outbound pieces under `src/adapters/postgres/`:
`pool.ts` is the verbatim move of the old `src/db.ts` (pool, `Database`,
`createDatabase`, `pgErrorCode`, `pgErrorConstraint`), `migrate.ts` is the runner
plus ledger SQL, exporting `runMigrations({ databaseUrl, migrationsDir? })` with
`databaseUrl` required and never reading config, and `event-hub.ts` implements the
`EventHub` port. `src/adapters/token-codec.ts` and `src/adapters/timing-safe.ts`
(`constantTimeEqual`, shared by HTTP auth and the GitHub signature) round out the
outbound side. Composition roots live in `src/composition/` (`config.ts` with
`loadConfig`/`Config`, `server.ts`, `cli.ts`, `mcp.ts`, `migrate.ts`). `src/db.ts`,
`src/config.ts`, `src/migrate.ts`, `src/server.ts`, `src/cli.ts`, `src/http/`, and
`src/mcp/` are deleted with no shims. `src/application/ports.ts` declares
`EventHub` (`subscribe`, `stats`, `close`) outside `Ports`/`TransactionPorts`;
`createApp` takes an injected `events: EventHub` and no longer takes `databaseUrl`,
and `src/composition/server.ts` owns the hub and the shutdown order (hub, then
server, then pool). `npm run check` now runs `check:arch` between typecheck and
tests. 195 tests pass.

LAS-175 is live: step 5 of the `ARCH.md` refactor layers the React client.
`web/src/domain/` holds the contract types (`Actor`, `Project`, `Issue`,
`IssueEvent`, `IssueTimeline`, `ReadyQueue`, `ProjectList`, `NewIssueInput`,
`ToastKind`, `ToastItem`) in `types.ts`; the status, priority, and event label
and tone maps plus `STATUS_ORDER`, `initials`, `matchesQuery`, `sortForColumn`,
`countByStatus`, `relativeTime`, `absoluteTime`, and `eventDetail` in
`presentation.ts`; and the pure `Route`, `parseRoute`, `boardPath`,
`queuePath`, `issuePath`, and `newIssuePath` in `routes.ts`, which touches no
React, `window`, or `history`. That layer imports exactly one backend module,
`src/domain/status.ts`. `web/src/application/` holds `errors.ts`
(`ApplicationError`, `isApplicationError`, `isUnauthorized`, `messageOf`, the
one application error type the adapters translate into), `ports.ts` (`ApiPort`,
`RealtimePort`, `NavigationPort`, and `IssuesChangedOptions`), and
`workspace.ts` (`useWorkspace` with the `Workspace`, `WorkspaceDeps`, and
`AuthState` types), which owns every session, project, issue, ready, realtime,
timeline, palette, and action concern with no JSX, no `fetch`, no
`EventSource`, and no history write. `web/src/adapters/` holds
`api-client.ts` (`createApiClient(): ApiPort` over `fetch`, mapping a network
failure to `ApplicationError(0, "network", ...)` and a non-ok response to
`ApplicationError(status, code, message)`), `realtime.ts` (`useIssuesChanged`
plus `realtime: RealtimePort`: one `EventSource` on `/api/events`, frames
filtered by project id, reconnect after 1s), and `history.ts`
(`useHistoryRouter(): NavigationPort` plus `NAVIGATE_EVENT`: `pushState`,
`replaceState`, `popstate`, and a `navigate` `CustomEvent`). `web/src/ui/` is
React and styles only: `AppView.tsx` renders the whole shell and every gate from
one `workspace` prop, `Boot.tsx` holds the boot screen and boot error card, and
no component imports `fetch`, `EventSource`, `history`, or an adapter module.
`SignIn` takes `onSignIn(token): Promise<void>` and reports
`ApplicationError.message` inline; `ProjectSetup` takes
`onCreate(input): Promise<Project>` plus `onCreated` and `onSignOut`.
`web/src/main.tsx` is the composition root: it creates the fetch client, calls
the history and realtime adapter hooks, injects the API, realtime, and
navigation ports into `useWorkspace`, and renders `AppView`; it is the only
module importing both `ui` and `application` and the only one constructing
adapters. `web/src/app.tsx`, `web/src/lib/`, `web/src/components/`, and the root
`web/src/styles.css` are deleted with no shims. Behavior and visuals are
unchanged. All six refactor steps and the import-direction gate are complete.
LAS-176 is complete: the refactor completion gate re-ran `./scripts/init.sh` and
`./scripts/clean-state.sh` green, with 195 tests passing and
`architecture: ok (74 files)`. The static audit proved `src/domain/` and
`src/application/` import only inward (the latter naming only `../domain/*.ts`,
`./ports.ts`, and its own use cases), with all 12 old-layer paths gone and no
`export ... from` shims anywhere in `src/` or `web/src/`. The real entry points
were re-exercised: the CLI project, issue, and agent commands, MCP over stdio
with a real `crv_` agent token, HTTP plus SSE in Chromium at 1440x900 and
390x844 with cross-tab updates and reconnect after a server restart, the GitHub
webhook signature, replay, and ignore paths including the unconfigured 503, and
the built SPA served by the HTTP process. No observable product behavior
changed. The only recorded deviations are the MCP blank-token hint naming
`node src/composition/cli.ts agent add <name>`, the `src/composition/*` command
paths in `package.json` and `scripts/db.sh`, and the pre-existing fixed
near-black palette with self-hosted fonts.

Tests: 195 pass, 0 fail, including `test/http.test.ts`, `test/event-hub.test.ts`,
`test/sse.test.ts`, the label and relation suites in `test/labels.test.ts` and
`test/relations.test.ts`, the webhook and branch suite in `test/github.test.ts`,
the issue filter and human-only edit cases in `test/issues.test.ts`,
`test/projects.test.ts` for create and list, duplicate and validation, the
transaction-scoped ports commit and rollback, and repository find by key, plus
`test/architecture.test.ts`, which proves the real tree passes and five fixtures
fail (application -> adapter, domain -> `pg`, web ui -> adapter, web application
-> adapter, web domain -> a backend module other than `src/domain/status.ts`).
`ARCH.md` codifies the layers and the one-way dependency rule; all six steps
have landed, along with the import-direction gate and the completion handoff,
so the refactor parent `LAS-167` and `LAS-176` are complete. `LAS-155` added the
end-to-end acceptance gate: `npm run acceptance` runs `scripts/acceptance.sh`
(`db.sh --no-migrate`, then `npm run build:web`), and `scripts/acceptance.mjs`
creates a throwaway `curved_acceptance_<pid>_<epoch>` database, migrates it,
runs the CLI lifecycle, MCP stdio with all eight tools, `npm start` with HTTP
plus SSE, a signed GitHub webhook and its replay, a `palette-seed` leg that
creates 24 backlog issues over the human bearer so the palette list overflows,
and the browser leg, then drops it and proves the default `curved` rows are
unchanged through per-table digests. The browser leg creates an issue through
the palette and the new issue dialog, lands on its detail route, and checks the
palette: a key query shows the issue key on the matched row, and ArrowDown
through the overflowing list scrolls the selected row fully into the listbox.
`--skip-browser` skips the seed and browser legs; `--keep` keeps the throwaway
database. `LAS-151`, `LAS-153`, and `LAS-154` are Done after black-box
verification: the webhook over HTTP and the CLI branch helper, issue detail and
its human actions in the browser, and the command palette once it rendered each
issue's key and scrolled the active option into view, which the gate now
guards.
`scripts/check-architecture.mjs` enforces
the rule set over `src/**/*.ts` and `web/src/**/*.ts(x)` from inside
`npm run check`.
`/home/dietkyle/projects/templates/ARCH.md`
carries the same rules as a project-agnostic template.

## Directory page

| Path | Role |
|---|---|
| `initial_idea.md` | Product intent and the design sketch. Source of truth for scope. |
| `ARCH.md` | Architecture contract: layer map, one-way dependency rule, rule ownership, ports and transactions, error translation, testing policy, review checklist. |
| `AGENTS.md` | This file: constraints and startup path. |
| `MEMORY.md` | Verified state, decisions, session log. Update it every session. |
| `src/domain/` | Pure rules and types: status and transition contract, actor matrix, claim and move policy, validation, key parsing, domain errors, shared record types. |
| `src/application/` | Ports (`ports.ts`) and the full SQL-free use-case set: `projects.ts`, `issues.ts` with `issue-read-model.ts`, `agents.ts`, `queue.ts`, `blocking.ts`, `comments.ts`, `labels.ts`, `relations.ts`, and `github.ts`. |
| `src/adapters/` | Adapters. Inbound: `http/` (router, auth, error mapping, request/response transport, webhook), `mcp/`, `cli/`, `github/` (signature and payload), `sse/`, `static/`. Outbound: `postgres/` (`pool.ts`, `migrate.ts`, `event-hub.ts`, `ports.ts` binding the pool and transactions, plus `repositories/`: projects, issues, issue events, issue meta, agents, labels, relations), `token-codec.ts`, `timing-safe.ts`. |
| `src/composition/` | Composition roots: `config.ts` (`loadConfig`), `server.ts` (HTTP entry, requires `CURVED_UI_TOKEN`, owns the event hub and shutdown), `cli.ts`, `mcp.ts`, `migrate.ts`. |
| `web/src/domain/` | Pure client domain: `types.ts` (contract types, `NewIssueInput`, toast types), `presentation.ts` (label/tone maps and formatting helpers), `routes.ts` (`Route`, `parseRoute`, and the path builders). May import only `src/domain/status.ts` from the server. |
| `web/src/application/` | Client ports and orchestration: `errors.ts` (`ApplicationError` and its guards), `ports.ts` (`ApiPort`, `RealtimePort`, `NavigationPort`), `workspace.ts` (`useWorkspace` and its types). React hooks allowed; no JSX, no `fetch`, no `EventSource`, no history writes. |
| `web/src/adapters/` | Transport adapters: `api-client.ts` (`createApiClient`), `realtime.ts` (`useIssuesChanged`, `realtime`), `history.ts` (`useHistoryRouter`, `NAVIGATE_EVENT`). |
| `web/src/ui/` | React and styles only: `AppView.tsx`, `Boot.tsx` and the shell, board, queue, detail, dialog, palette, sign-in, setup, toast, and primitive components plus `styles.css`. No transport imports. |
| `web/src/main.tsx` | Composition root: creates the API client, calls the history and realtime adapters, injects all three ports into `useWorkspace`, renders `AppView`. |
| `web/` | Vite + React SPA around `web/src/`. `npm run build` writes `web/dist`; `npm start` serves it; `npm run dev` proxies `/api` to 4747. |
| `scripts/init.sh` | Baseline runner: install, check, build. `--no-install` skips install. |
| `scripts/check-architecture.mjs` | Import-direction check over `src/**/*.ts` and `web/src/**/*.ts(x)`; exits 1 on any violation. |
| `scripts/clean-state.sh` | End-of-session gate. Idempotent, writes nothing. |
| `scripts/acceptance.sh` | Acceptance entry: `bash scripts/db.sh --no-migrate`, `npm run build:web`, then `scripts/acceptance.mjs` with the caller's flags. |
| `scripts/acceptance.mjs` | End-to-end gate over a throwaway database: CLI, MCP, server, HTTP plus SSE, webhook, palette seed, browser; drops the database and fails if the default `curved` rows changed. `--skip-browser`, `--keep`. |
| `scripts/acceptance-browser.mjs` | Dependency-free Chromium/CDP driver at 390x844 over the built SPA; writes run-scoped screenshots under the system temp dir. `CHROMIUM_BIN` overrides the binary search. |
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
- `npm run acceptance` green before the item is reported done.
- `MEMORY.md` dated today with what changed and the next step.

## End of session

1. Update `MEMORY.md`: `- **Last updated:** <today>` plus the session entry.
2. Note unresolved risk or blockers explicitly.
3. Run `./scripts/clean-state.sh`.
4. Commit the work and push `main` to `origin`; report success only once
   `git ls-remote origin main` matches local `HEAD`.
