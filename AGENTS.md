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
`curved_session` cookie (an opaque nonce whose SHA-256 is an `auth_sessions`
row; the cookie carried the SHA-256 of the UI token until passkey login
shipped) and agents by `crv_` bearer,
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

LAS-179 is live: an opt-in `COOKIE_SECURE` setting. `Config` gains
`cookieSecure` (default false) parsed from `COOKIE_SECURE`: unset or empty is off,
`1` or `true` (case-insensitive) is on, `0` or `false` is off, and any other value
throws an error whose message names `COOKIE_SECURE`.
`serializeSessionCookie` and `serializeClearedSessionCookie` take an optional
`secure` flag and append `; Secure` only when it is true, preserving the existing
`HttpOnly; SameSite=Lax; Path=/; Max-Age=...` attributes and their order.
`CreateAppOptions.cookieSecure` defaults to false, and
`src/composition/server.ts` passes `config.cookieSecure`. When on, both the login
and logout `Set-Cookie` values also carry `Secure`; local HTTP development and the
acceptance browser gate keep the default, so no other cookie, auth, SSE, or
webhook behavior changes. The app-level test sets `cookieSecure: true` and asserts
both cookies, and the default-off suite is unchanged.

Passkey login is live. Migration `0006_passkeys.sql` adds `passkey_credentials`,
`auth_sessions`, and `webauthn_challenges`, and `@simplewebauthn/server` 14.1
plus `@simplewebauthn/browser` 14.0 are dependencies. Browser sessions are now
opaque server-side rows: the `curved_session` cookie holds a 32-character
base64url nonce (192 bits), only its SHA-256 is stored in `auth_sessions`, and
rows expire after 30 days (`SESSION_MAX_AGE_SECONDS=2592000`). Token and passkey
logins both create a row, and `DELETE /api/session` deletes the row, so logout
revokes it. The old deterministic `sha256(UI_TOKEN)` cookie is gone, so existing
cookies require a new sign-in. `src/application/sessions.ts` and
`src/application/passkeys.ts` own the use cases, with
`src/adapters/postgres/repositories/` `passkeys.ts`, `auth-sessions.ts`, and
`passkey-challenges.ts` behind them; `src/adapters/http/auth.ts` resolves the
cookie through the session row. Routes: `GET /api/passkeys/available` (no auth,
`{ available }`, `cache-control: no-store`), `GET /api/passkeys`, `POST
/api/passkeys/options`, `POST /api/passkeys` (201 `{ passkey }`), and `DELETE
/api/passkeys/:id` (204) are human-only, while `POST
/api/session/passkey/options` and `POST /api/session/passkey` are
unauthenticated login options and completion returning the actor plus the
session cookie. Human-only routes accept the UI bearer or the session cookie.
`CURVED_WEBAUTHN_ORIGINS` (comma-separated) and `CURVED_WEBAUTHN_RP_ID` are
optional overrides: origins default to `https://$CURVED_DOMAIN` when
`CURVED_DOMAIN` is set, else `http://localhost:4747` and
`http://localhost:5173`, and the RP ID defaults to the hostname of the first
origin. Explicit origins must be bare http/https origins and must match the RP
ID or be subdomains of it; compose passes `CURVED_DOMAIN`, so `deploy/.env`
needs no new key. In the SPA, `SignIn` leads with a primary "Sign in with
passkey" button (Face ID, Touch ID, or a security key) above a "Use a UI token"
divider, and any signed-in session opens `PasskeysDialog` from the topbar, the
sidebar footer, or the palette action "Manage passkeys" to add a nicknamed
passkey or remove one; `web/src/adapters/passkeys.ts` calls the browser
credential API. One implicit human identity owns many passkeys, so there is no
users table and no actor or timeline change; the token bearer stays valid for
deploy, health, CLI, MCP, and acceptance. `npm run check` now passes 205 tests
(199 behavior, 6 architecture) with `architecture: ok (81 files)`, including the
new `test/passkeys.test.ts` and updated HTTP/SSE session tests; `npm run
acceptance` passes 145 checks including `PASS browser: passkey registered ...`
and `PASS browser: passkey sign-in reached the board ...` through Chromium's CDP
virtual authenticator (focus emulation is enabled because headless tabs
otherwise reject WebAuthn with `NotAllowedError`), and `npm run smoke:compose`
stays green with the new `CURVED_DOMAIN` env.

The UI bearer token still authenticates deploy, health, CLI, and MCP, and its
only copy is `CURVED_UI_TOKEN` in `/srv/curved/checkout/deploy/.env` on the
host. Only the GitHub deploy key can reach the host over SSH, so
`.github/workflows/rotate-ui-token.yml` is the rotation and recovery path when
the deployed value is unknown or lost: set the repository secret with
`gh secret set CURVED_UI_TOKEN < value`, dispatch
`gh workflow run rotate-ui-token.yml`, and the job pipes the token over stdin
(never argv, never a log line) to `deploy@$DEPLOY_HOST`, atomically rewrites the
mode-600 env line with backup and release re-run on failure, runs
`./deploy/release.sh`, and proves `POST https://$CURVED_DOMAIN/api/session`
returns 200 with the new token. Existing browser sessions stay valid; only new
token logins use the new value.

LAS-180 is live: a root multi-stage `node:26-slim` `Dockerfile` plus
`.dockerignore`. The build stage runs `npm ci`, `npm run build:web`, and
`npm prune --omit=dev`; the runtime stage copies `package.json`, the production
`node_modules`, `src`, `migrations`, and `web/dist`, runs as `USER node`, and
starts `node src/composition/server.ts`. The image excludes `.env`, tests,
`scripts`, and deployment assets. `scripts/container-smoke.sh`
(`npm run smoke:container`) starts the local database, builds
`curved:container-smoke`, and asserts the SPA shell, `401` and `200` on
`/api/projects`, `already up to date` from the in-image migrate command, a
non-root uid, and the absent paths. `--platform` supports arm64, and the
Dockerfile has no arch-specific steps.

LAS-181 is live: `.github/workflows/verify.yml` is the GitHub Actions gate for
`main`. It runs on every push to `main` and on manual dispatch, in one global
concurrency group `verify` with `cancel-in-progress: false`, so two runs never
execute at once. The `verify` job runs on `ubuntu-latest` with a
`postgres:18-alpine` service on host port 55432, then `npm ci`,
`npm run typecheck`, `npm run check:arch`, `npm test`, and `npm run build:web`.
LAS-185 later added the `deploy` job to the same workflow with `needs: verify`
and `if: github.ref == 'refs/heads/main'`, so a green `verify` gates every
production release.

LAS-182 is live: the production Compose stack lives in `deploy/`.
`deploy/docker-compose.yml` (compose project `curved-prod`) runs `db`
(`postgres:18-alpine`, published only on
`127.0.0.1:${CURVED_DB_PORT:-55432}:5432`), `app` (built from the repository root
`Dockerfile`, no host ports, migrations then the server, and an authenticated
in-container health check on `/api/projects`), and `caddy` (`caddy:2.10-alpine`,
publishing `${CURVED_HTTP_PORT:-80}:80`, `${CURVED_HTTPS_PORT:-443}:443`, and
443/udp), with startup ordered db healthy -> app healthy -> caddy.
`deploy/Caddyfile` serves `{$CURVED_DOMAIN:localhost}` and sets
`tls {$ACME_EMAIL:internal}`: an empty `ACME_EMAIL` uses Caddy's internal CA for
local TLS, and an email switches to ACME. It sends
`Strict-Transport-Security: max-age={env.CURVED_HSTS_MAX_AGE}` only when that
variable is non-empty, compresses with zstd or gzip except on `/api/events`, and
proxies `/api/events` separately with `flush_interval -1` so SSE frames flush;
both handlers proxy `app:4747`, and Caddy's automatic HTTPS redirects port 80 to
the HTTPS site. `deploy/.env.example`, copied to the gitignored mode-600 `deploy/.env`,
lists `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `CURVED_UI_TOKEN`,
`GITHUB_WEBHOOK_SECRET`, `CURVED_DOMAIN`, `ACME_EMAIL`, `CURVED_HSTS_MAX_AGE`,
`COOKIE_SECURE=1`, and the optional host-port and image overrides, plus
commented `CURVED_WEBAUTHN_ORIGINS` and `CURVED_WEBAUTHN_RP_ID` overrides that
default from `CURVED_DOMAIN`.
`npm run smoke:compose` runs `scripts/compose-smoke.sh`, which builds and starts
the stack under a throwaway project and env on free high ports, extracts Caddy's
internal root CA, and asserts over HTTPS the SPA shell, the `308` HTTP to HTTPS
redirect, no HSTS while `CURVED_HSTS_MAX_AGE` is empty and
`max-age=31536000` after enabling it, gzip on the JS asset, `401`/`200` on
`/api/projects`, the `Secure` session cookie, project and issue creation,
`/api/ready`, issue detail, `/api/issues`, SSE `ready` plus an `issues_changed`
frame within 5s, the unsigned webhook `401`, the loopback-only Postgres bind, and
that the app publishes no host port.
Agents reach the deployed Postgres through an SSH tunnel (port 55433 is the
future tunnel convention); the stack exposes only `127.0.0.1:55432` for that
purpose. The development root `docker-compose.yml` is unchanged, and
`docker compose -f deploy/docker-compose.yml down -v` deletes the Postgres and
Caddy volumes, so it must never run on the server.

LAS-183 is live: the Oracle Cloud provisioning boundary. `deploy/provisioning.md`
is the console runbook: one Always Free `VM.Standard.A1.Flex` (2 OCPU, 12 GB,
Ubuntu 24.04 aarch64, home region), a 50 GB boot volume plus a 100 GB block
volume, a reserved public IPv4, a DNS-only `A` record, and a security list with
only 22/tcp, 80/tcp, 443/tcp, and 443/udp. `deploy/bootstrap-host.sh` is
idempotent: it installs Docker from the Ubuntu packages (Docker's apt repository
with `docker-compose-plugin` as the fallback), creates the key-only `deploy` user
in the `docker` group (root-equivalent, documented), writes
`/etc/ssh/sshd_config.d/00-curved-access.conf` (public keys only, password and
keyboard-interactive auth off, root login off, `AllowUsers ubuntu deploy`),
formats only an unformatted 90-110 GiB data disk as ext4 and mounts it at
`/srv/curved` with a UUID fstab entry, clones the checkout to
`/srv/curved/checkout`, generates the mode-600 `deploy/.env` once without
printing secrets, and starts the compose stack, using Caddy's internal CA unless
`--acme-email` was passed; then it also sets `CURVED_HSTS_MAX_AGE=31536000` so
Caddy requests a public certificate and enforces HSTS.
`deploy/verify-host.sh` is read-only and exits 0 only when the OS, deploy
account, sshd policy, ext4 data mount, 50 + 100 = 150 of the 200 GB block
storage, env permissions, checkout, public listener allowlist (22/80/443 TCP
plus 443/68/546 UDP, no public 5432 or 4747, `127.0.0.1:55432` present), healthy
compose services, `tls-certificate` (verified HTTPS), `http-redirect` (HTTP to
HTTPS), `hsts` (the configured max-age), `compression` (a compressed asset),
`caddy-issuance` (an ACME certificate in the Caddy log), and the authenticated
200/401 HTTPS API all pass; the LAS-183 live run printed 22 PASS lines, and
LAS-187 and LAS-188 added the four backup checks and `keepalive-timer`, for 27.
`npm run smoke:provision` runs both scripts in a disposable `ubuntu:24.04`
container with PATH stubs, and asserts a fresh bootstrap, an idempotent rerun,
the verifier's happy path, the public mode generated by `--acme-email` with its
certificate, redirect, HSTS, compression, and issuance checks, the negatives for
an unverified certificate, missing HSTS, an HTTP 200 instead of a redirect, a
missing ACME marker, and internal HSTS, the hourly keepalive unit with its
installed script and a disabled keepalive timer negative, and rejection of a
public 5432 listener, password authentication, and a non-public `--key` line.
The OCI console steps and live host checks are operator-executed; LAS-186
delivered the public
ACME/HSTS/webhook edge on this host, release automation and the SSH deploy job
landed in LAS-185, and backups are LAS-187.

LAS-184 is live: durable data root and host hygiene. Bootstrap mounts the data
volume before Docker may start, creates `/srv/curved/docker` (root:root 0710),
writes the managed `/etc/docker/daemon.json` (`data-root` `/srv/curved/docker`,
`json-file` rotation `10m` x `3`, builder GC `5GB`), installs the
`/etc/systemd/system/docker.service.d/10-curved-data-root.conf` drop-in
(`RequiresMountsFor=/srv/curved/docker`, `ConditionPathIsMountPoint=/srv/curved`),
and installs `curved-docker-prune.service` plus a daily 04:37 timer that prunes
build cache older than 168h and unused images older than 720h. An existing
`/var/lib/docker` is copied once with `cp -a` and kept; the migrated root is
re-chmoded 0710, and the run that changes `daemon.json` recreates the Compose
containers with `--force-recreate` so the logging defaults reach Postgres, app,
and Caddy. The verifier adds `docker-root`, `docker-config`,
`docker-mount-dependency`, and `docker-prune-timer`; the provisioning gate
proves the migration, config, mount dependency, timer, container recreation,
idempotent rerun, and two verifier negatives. The live reboot proof was executed
on the OCI instance on 2026-11-18: bootstrap, a full `verify-host: ok`, a reboot,
and `verify-host: ok` again with the stack healthy.

LAS-185 is live: release automation and the SSH deploy job. `deploy/release.sh`
(executable) is the only release path. It starts the database
(`up -d --wait --wait-timeout 300`), builds `curved:<short-sha>`, runs the
one-shot `run --rm --no-deps -T app node src/composition/migrate.ts`, recreates
the app (`up -d --no-deps --wait --wait-timeout 600`), starts caddy
(`up -d --no-deps`), then probes `GET https://$CURVED_DOMAIN/api/projects` with
the UI bearer, extracting Caddy's internal root CA via
`compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt` when
`ACME_EMAIL` is empty, and with a public `ACME_EMAIL` requiring a
`Strict-Transport-Security` header whose max-age matches
`CURVED_HSTS_MAX_AGE`; only after a passing probe does it tag
`curved:<short-sha>` as `curved:latest`, write state atomically to
`/srv/curved/release-state`, and print `release: ok <short>`. A failed
migration exits before any app or caddy recreate, latest tag, or state write and
states the previous app is still serving. An absent state file means the first
release, which skips the public probe unless `--require-public-probe`; later
releases require it and a probe failure is red, leaving latest and state
untouched. `--skip-public-probe` skips with a warning, and both flags together
is a usage error. `./deploy/release.sh rollback <tag>` normalizes
`curved:<tag>`, requires `docker image inspect`, runs no migrations, recreates
app then caddy, applies the same probe policy, updates state, and warns that a
non-backward-compatible migration requires a database restore instead of an
image rollback.
`.github/workflows/verify.yml` adds a `deploy` job with `needs: verify` and
`if: github.ref == 'refs/heads/main'`, so it runs on a push to `main` and on
manual dispatch only after verification passes. It validates the
`DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, and `DEPLOY_HOST` secrets, writes the key
and known_hosts under `$RUNNER_TEMP` mode 600, and SSHes as `deploy@$DEPLOY_HOST`
with BatchMode, IdentitiesOnly, and StrictHostKeyChecking=yes against the pinned
file to run
`cd /srv/curved/checkout && git fetch --prune origin main && git reset --hard origin/main && ./deploy/release.sh`;
a manual dispatch exposes a `skip_public_probe` boolean that appends
`--skip-public-probe`. `npm run smoke:release` runs
`scripts/release-smoke.sh`, the release gate. Live proof on 2026-11-19: push run
44538665002 (verify 1m10s, deploy 40s) deployed commit fcfafd4, reset the host
checkout to fcfafd4, created `curved:fcfafd4` and `curved:latest`, left the app
healthy on `curved:fcfafd4`, wrote the state file, and logged the first-release
probe skip; manual dispatch run 44539044406 (verify 58s, deploy 16s) re-released
fcfafd4 against the existing state with `release: public probe ok`; a rollback
to the pre-release image retagged `curved:480a069` recreated a healthy app,
probed, and recorded state, and a forward release returned to `curved:fcfafd4`
with `tag=curved:fcfafd4 sha=fcfafd4 at=2026-11-19T14:02:06Z`. The deploy key is
a dedicated Ed25519 pair whose private half exists only as the `DEPLOY_SSH_KEY`
repository secret.

LAS-186 is live: the public HTTPS edge. The host serves
`https://158.101.127.247.sslip.io` with a Let's Encrypt certificate (issuer
`YE2`, subject `CN=158.101.127.247.sslip.io`, valid to Feb 17 2027), with
`CURVED_DOMAIN=158.101.127.247.sslip.io`. The name is sslip.io wildcard DNS,
which resolves to the reserved IPv4 `158.101.127.247`; the record is DNS-only,
so the ACME challenge reaches the host directly. `deploy/.env` carries
`ACME_EMAIL=admin@sslip.io`, `CURVED_HSTS_MAX_AGE=31536000`, and
`COOKIE_SECURE=1`: Caddy obtained the certificate over ACME (the log records
`certificate obtained successfully`, identifier
`158.101.127.247.sslip.io`, issuer
`acme-v02.api.letsencrypt.org-directory`, challenge tls-alpn-01), `http://`
answers `308` to the HTTPS URL, `GET /` sends
`strict-transport-security: max-age=31536000`, the JS asset
`/assets/index-CjN4_7RW.js` is served with `content-encoding: gzip`, and
`/api/events` delivers `ready` then `issues_changed` with `data: 1` after a
comment.
Unauthenticated `GET /api/projects` stays 401 and a session login returns 200
through the public edge. `deploy/verify-host.sh` exits 0 with 22 PASS lines at
that point (27 after LAS-188), including `tls-certificate`, `http-redirect`,
`hsts` (max-age 31536000), `compression`, `caddy-issuance`, and `https-api`
(200/401). The release probe
requires HSTS under ACME, and deploy run 44551897724 logged
`release: public probe ok` followed by `release: ok c711540`.
`deploy/webhook.sh` creates or updates the repository `pull_request` hook
(id 714067501, `config.content_type: json`) at
`https://158.101.127.247.sslip.io/webhooks/github`, always PATCHing an existing
hook with the same URL so the secret is reapplied. The live pull request flow:
PR #1 (`LIVE-1`) opened -> issue `in_review` with an `actorType git` event body
`pull request #1 opened`, merge -> `done` with `pull request #1 closed`; PR #2
(`LIVE-3`) open -> `in_review`, close unmerged -> ignored with the status left at
`in_review`, a human move back to `in_progress`, reopen -> `in_review` with
`pull request #2 reopened`, merge -> `done` with `pull request #2 closed`. A
replayed identical signed delivery and an unknown key (`NOPE-999`) both answer
`200 {"ok":true,"ignored":true}` with the issue unchanged, as do non-PR
`issues` and `push` deliveries. Gates: `npm run check` 205 tests plus the
architecture check, compose smoke (HTTP 308, no HSTS by default and HSTS after
enabling, gzip on the JS asset, SSE `issues_changed` within 5s),
`npm run smoke:provision` 50 PASS, `npm run smoke:release` 22 PASS,
`npm run smoke:backup` 19 PASS, and `npm run smoke:webhook` 9 PASS.

LAS-187 is live: backups and restore. `deploy/backup.sh` writes one private set per
run under `$CURVED_BACKUP_DIR` (default `/srv/curved/backups`, mode 0700):
`<kind>/<UTC timestamp>/` with a `postgres.dump` custom-format dump from the
running `db` container, `caddy-data.tar.gz` and `caddy-config.tar.gz` from the
running `caddy` container (skipped with `caddy=skipped` for `pre-deploy` when
Caddy is absent), a fixed-key `manifest.txt`, and `SHA256SUMS`; staging is
published atomically, `latest` is a relative symlink, an `flock` prevents
overlap, and retention keeps the newest 7 sets per kind. `deploy/restore.sh`
verifies `SHA256SUMS` and requires `--yes`, stops the app before a production
Postgres restore and leaves it stopped, restores a `--database` drill without
stopping the app, and restores the Caddy volumes by stopping Caddy, extracting
both archives through a one-shot container, and starting it again.
`deploy/release.sh` takes a `pre-deploy` backup after the database is up and
before the build or any migration, and aborts the release if it fails.
Bootstrap creates the backup directory and installs `curved-backup.service`
plus `curved-backup.timer` (daily 03:17, 20 minute jitter, `Persistent=true`,
as `deploy`), takes one initial nightly set, and `verify-host` adds
`backup-dir`, `backup-timer`, `backup-freshness` (26 hour limit), and
`backup-integrity`. `npm run smoke:backup` is the stub gate; `smoke:compose`
now takes a real nightly set, restores it into a throwaway database containing
`SMK-1`, and restores Caddy; `smoke:release` asserts the backup ordering and
failure isolation; `smoke:provision` covers the units, initial set, verifier
checks, and four negatives. Repository gates now: 205 tests,
`architecture: ok (81 files)`, acceptance 145 checks, `smoke:provision`
50 PASS, `smoke:release` 22 PASS, `smoke:backup` 19 PASS, `smoke:compose`
(including the backup and restore legs) green, and `smoke:webhook` 9 PASS
unchanged. Live on 2026-11-19: deploy run 44578798179 passed `verify` and the
SSH `deploy` job, whose release recorded pre-deploy set
`20261119T173637Z` with `tag=curved:ec6666d` and `caddy=archived`; the
bootstrap re-run installed `curved-backup.timer`, the first nightly set
`20261119T173741Z` published and verified against `SHA256SUMS`, `verify-host`
exits 0 with 26 PASS lines including the four backup checks, and a live
`restore.sh postgres ... --database curved_backup_drill` restored 1 project
and 3 issues with `LIVE-1` at `done` while the app kept answering 200; the
drill database was dropped.

LAS-188 is live: the free-tier keepalive and the rebuild runbook.
`deploy/keepalive.sh` burns one core at `nice 19` for ten minutes (default 600
seconds, `CURVED_KEEPALIVE_SECONDS` and `CURVED_KEEPALIVE_CPUS` override it,
`taskset` pins core 0 when present, and timeout exits 124/143 count as
success), which keeps Oracle's CPU 95th percentile above its 20% idle-reclaim
threshold without a sustained average. Bootstrap installs it as
`/usr/local/bin/curved-keepalive` (root:root 0755) and writes
`curved-keepalive.service` (`Type=oneshot`, `Nice=19`, `IOSchedulingClass=idle`,
`TimeoutStartSec=700`) plus `curved-keepalive.timer` (`OnCalendar=hourly`,
`AccuracySec=1min`), then enables the timer. `verify-host` adds
`keepalive-timer` (both units, executable script, timer enabled and active) for
27 checks, and `smoke:provision` now asserts the installed script, units, timer
state, idempotent reinstall, and a disabled-timer negative, for 52 PASS.
`deploy/provisioning.md` section 18 documents the keepalive and the
rebuild-after-reclamation runbook: new A1 instance, existing volume attached
unformatted (or a new volume plus `restore.sh postgres` from the newest
off-host dump), reserved IPv4 reassigned, known-hosts refreshed, bootstrap
reinstalls the units and user, then `release.sh` and 27 PASS. Live on
2026-11-19: bootstrap `--no-stack` installed the units, `verify-host` exited 0
with 27 PASS and 0 FAIL, and 12 `/proc/stat` samples during a 62 second run
read 53-56% total CPU, p95 55%, average 54.1%; the timer's next elapse was
19:00 UTC. The console reclamation step itself remains operator-executed.

Tests: 205 pass, 0 fail, including `test/http.test.ts` and `test/sse.test.ts`,
whose session cases exercise the opaque `auth_sessions` cookie rows,
`test/passkeys.test.ts` for availability without auth, listing without
verification material, registration and login option contents, single-use
challenges, unknown credentials, and nickname validation,
`test/event-hub.test.ts`, the label and relation suites in `test/labels.test.ts`
and `test/relations.test.ts`, the webhook and branch suite in
`test/github.test.ts`, the issue filter and human-only edit cases in
`test/issues.test.ts`, `test/projects.test.ts` for create and list, duplicate
and validation, the transaction-scoped ports commit and rollback, and
repository find by key, plus `test/architecture.test.ts`, which proves the real
tree passes and five fixtures fail (application -> adapter, domain -> `pg`, web
ui -> adapter, web application -> adapter, web domain -> a backend module other
than `src/domain/status.ts`). Those 205 are the node tests (199 behavior and 6
architecture); `npm run smoke:release` is a shell gate, not part
of them. `ARCH.md` codifies the layers and the one-way dependency rule; all
six steps have landed, along with the import-direction gate and the completion
handoff, so the refactor parent `LAS-167` and `LAS-176` are complete. `LAS-155`
added the end-to-end acceptance gate: `npm run acceptance` runs
`scripts/acceptance.sh` (`db.sh --no-migrate`, then `npm run build:web`), and
`scripts/acceptance.mjs` creates a throwaway `curved_acceptance_<pid>_<epoch>`
database, migrates it, runs the CLI lifecycle, MCP stdio with all eight tools,
`npm start` with HTTP plus SSE, a signed GitHub webhook and its replay, a
`palette-seed` leg that creates 24 backlog issues over the human bearer so the
palette list overflows, and the browser leg, then drops it and proves the
default `curved` rows are unchanged through per-table digests. The browser leg
creates an issue through the palette and the new issue dialog, lands on its
detail route, and checks the palette: a key query shows the issue key on the
matched row, and ArrowDown through the overflowing list scrolls the selected row
fully into the listbox. It also registers a passkey through Chromium's CDP
virtual authenticator and signs in with it, printing `PASS browser: passkey
registered ...` and `PASS browser: passkey sign-in reached the board ...`; focus
emulation is enabled because headless tabs otherwise reject WebAuthn with
`NotAllowedError`. The gate reports 145 checks in total.

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
| `Dockerfile` | Multi-stage `node:26-slim` production image: build (`npm ci`, `build:web`, prune dev), then a runtime stage as `USER node`. |
| `.dockerignore` | Build-context exclusions for the image build. |
| `deploy/` | Production compose stack (`docker-compose.yml`), the Caddy TLS config (internal CA locally, ACME with optional HSTS, gzip/zstd except SSE, `/api/events` flushed), the environment template, and `release.sh` (pre-deploy backup, build, migrate, recreate app then caddy, authenticated probe with the HSTS rule under ACME, latest tag, atomic state, rollback); app and Caddy are compose-network only, Postgres binds loopback. |
| `deploy/backup.sh` | Backup writer: atomically publishes a private `<kind>/<timestamp>` set with a `pg_dump` custom dump, the Caddy data and config archives, `manifest.txt`, and `SHA256SUMS`; `flock`, relative `latest` symlink, retention per kind, `nightly` and `pre-deploy` kinds. |
| `deploy/restore.sh` | Restore path: checksum-verified Postgres restore into the production database (stops the app, leaves it stopped) or a `--database` drill, plus Caddy volume restore; requires `--yes`. |
| `deploy/keepalive.sh` | Always Free keepalive: one core at `nice 19` for ten minutes hourly (`taskset` on core 0 when present, 600 second default, timeout exits counted as success), installed as `/usr/local/bin/curved-keepalive` and driven by `curved-keepalive.timer`. |
| `deploy/provisioning.md` | OCI console runbook: topology, security list, reserved IPv4, DNS-only record, bootstrap and verifier commands, Docker data root and mount gate, reboot persistence, LAS-183 and LAS-184 acceptance evidence, the public ACME/HSTS edge and webhook evidence, capacity fallback, access boundary, storage, releases and rollback, backups and restore, the keepalive and the rebuild-after-reclamation runbook (section 18), troubleshooting. |
| `deploy/bootstrap-host.sh` | Idempotent Ubuntu 24.04 host bootstrap: Docker install, Docker data root on the data volume with the mount dependency, log rotation and prune timer, 0700 backup directory with the daily backup timer and one initial nightly set, hourly keepalive units and `/usr/local/bin/curved-keepalive`, key-only `deploy` user and sshd drop-in, ext4 data volume and UUID fstab entry, checkout, mode-600 env, compose up. |
| `deploy/verify-host.sh` | Read-only host verifier: OS, deploy account, sshd policy, ext4 mount, 150 GB storage, Docker data root, daemon config, mount dependency and prune timer, keepalive timer and script, backup directory, timer, freshness and integrity, env, checkout, listener allowlist, stack health, `tls-certificate`, `http-redirect`, `hsts`, `compression`, `caddy-issuance`, and the 200/401 HTTPS API. |
| `deploy/webhook.sh` | Creates or updates the GitHub `pull_request` webhook for the deployed host (default `https://$CURVED_DOMAIN/webhooks/github`), always PATCHing an existing same-URL hook so the secret is reapplied; `--repo`, `--url`, `--env-file`, `--dry-run`. |
| `.github/workflows/verify.yml` | CI gate: push to main plus manual dispatch, Postgres 18 service, typecheck, architecture check, tests, web build; the main-only `deploy` job (`needs: verify`) SSHes with the `DEPLOY_*` secrets and runs `deploy/release.sh`. |
| `.github/workflows/rotate-ui-token.yml` | Manual `workflow_dispatch` token recovery: validates the `DEPLOY_*` and `CURVED_UI_TOKEN` secrets, pipes the token over stdin to `deploy@$DEPLOY_HOST`, atomically rewrites the mode-600 env line with backup and release re-run on failure, runs `deploy/release.sh`, and proves a 200 from `POST /api/session`. Concurrency group `rotate-ui-token`. |
| `src/domain/` | Pure rules and types: status and transition contract, actor matrix, claim and move policy, validation, key parsing, domain errors, shared record types. |
| `src/application/` | Ports (`ports.ts`) and the full SQL-free use-case set: `projects.ts`, `issues.ts` with `issue-read-model.ts`, `agents.ts`, `queue.ts`, `blocking.ts`, `comments.ts`, `labels.ts`, `relations.ts`, `github.ts`, `sessions.ts` (opaque session creation and `SESSION_MAX_AGE_SECONDS`), and `passkeys.ts` (availability, listing, registration, and login options). |
| `src/adapters/` | Adapters. Inbound: `http/` (router, auth, error mapping, request/response transport, webhook), `mcp/`, `cli/`, `github/` (signature and payload), `sse/`, `static/`. Outbound: `postgres/` (`pool.ts`, `migrate.ts`, `event-hub.ts`, `ports.ts` binding the pool and transactions, plus `repositories/`: projects, issues, issue events, issue meta, agents, labels, relations, passkeys, auth sessions, and passkey challenges), `token-codec.ts`, `timing-safe.ts`. |
| `src/composition/` | Composition roots: `config.ts` (`loadConfig`, including WebAuthn origins and RP ID resolution), `server.ts` (HTTP entry, requires `CURVED_UI_TOKEN`, owns the event hub and shutdown), `cli.ts`, `mcp.ts`, `migrate.ts`. |
| `web/src/domain/` | Pure client domain: `types.ts` (contract types, `NewIssueInput`, toast types), `presentation.ts` (label/tone maps and formatting helpers), `routes.ts` (`Route`, `parseRoute`, and the path builders). May import only `src/domain/status.ts` from the server. |
| `web/src/application/` | Client ports and orchestration: `errors.ts` (`ApplicationError` and its guards), `ports.ts` (`ApiPort` including passkey availability, listing, registration, login, and removal, `RealtimePort`, `NavigationPort`, `PasskeyPort`), `workspace.ts` (`useWorkspace` and its types, including passkey state). React hooks allowed; no JSX, no `fetch`, no `EventSource`, no history writes, no credential API. |
| `web/src/adapters/` | Transport adapters: `api-client.ts` (`createApiClient`), `realtime.ts` (`useIssuesChanged`, `realtime`), `history.ts` (`useHistoryRouter`, `NAVIGATE_EVENT`), `passkeys.ts` (`createPasskeysAdapter(): PasskeyPort` over `@simplewebauthn/browser` for support, registration, and authentication). |
| `web/src/ui/` | React and styles only: `AppView.tsx`, `Boot.tsx`, `PasskeysDialog.tsx`, and the shell, board, queue, detail, dialog, palette, sign-in (passkey button plus the UI-token divider), setup, toast, and primitive components plus `styles.css`. No transport imports. |
| `web/src/main.tsx` | Composition root: creates the API client and passkey adapter, calls the history and realtime adapters, injects all four ports into `useWorkspace`, renders `AppView`. |
| `web/` | Vite + React SPA around `web/src/`. `npm run build` writes `web/dist`; `npm start` serves it; `npm run dev` proxies `/api` to 4747. |
| `scripts/init.sh` | Baseline runner: install, check, build. `--no-install` skips install. |
| `scripts/check-architecture.mjs` | Import-direction check over `src/**/*.ts` and `web/src/**/*.ts(x)`; exits 1 on any violation. |
| `scripts/clean-state.sh` | End-of-session gate. Idempotent, writes nothing. |
| `scripts/acceptance.sh` | Acceptance entry: `bash scripts/db.sh --no-migrate`, `npm run build:web`, then `scripts/acceptance.mjs` with the caller's flags. |
| `scripts/acceptance.mjs` | End-to-end gate over a throwaway database: CLI, MCP, server, HTTP plus SSE, webhook, palette seed, browser; drops the database and fails if the default `curved` rows changed. `--skip-browser`, `--keep`. |
| `scripts/acceptance-browser.mjs` | Dependency-free Chromium/CDP driver at 390x844 over the built SPA; writes run-scoped screenshots under the system temp dir. `CHROMIUM_BIN` overrides the binary search. |
| `scripts/container-smoke.sh` | Container contract gate: starts the local DB, builds `curved:container-smoke`, and asserts the SPA shell, `401`/`200` on `/api/projects`, `already up to date` from the in-image migrate, a non-root uid, and the absent paths. `--platform`, `--build-only`, `--keep`. |
| `scripts/compose-smoke.sh` | Production compose gate: throwaway project and env, HTTPS through Caddy's internal CA, the HTTP 308 redirect, the HSTS toggle (absent by default, `max-age=31536000` after enabling), gzip on the JS asset, SPA/API/ready/detail assertions, SSE `ready` and `issues_changed` within 5s, unsigned webhook 401, the bind/port checks, and a real nightly backup restored into a throwaway database plus a Caddy volume restore. |
| `scripts/backup-smoke.sh` | Backup and restore gate (`npm run smoke:backup`): stub Docker over the real scripts; set layout, manifest keys, checksums, retention, failure isolation, pre-deploy Caddy skip, `--yes` refusal, checksum tamper, drill versus production restore, and Caddy restore ordering. |
| `scripts/provision-smoke.sh` | Provisioning gate: runs the bootstrap and verifier in a disposable Ubuntu 24.04 container with PATH stubs; fresh and idempotent bootstrap, Docker data-root migration, daemon config, mount dependency, prune timer, keepalive unit/script/idempotent reinstall, backup directory and units, one initial nightly set, container recreation, verifier positive, the `--acme-email` public mode (certificate, redirect, HSTS, compression, ACME issuance), the public negatives (unverified certificate, missing HSTS, HTTP 200 instead of a redirect, missing ACME marker, internal HSTS), wrong-root, disabled prune and keepalive timers, missing/stale/corrupt backup, and inactive backup-timer negatives, and public-5432 and password-auth negatives. |
| `scripts/release-smoke.sh` | Release gate (`npm run smoke:release`): asserts `deploy/release.sh` release order including the pre-deploy backup before build and migration, the pre-deploy backup failure isolation, the first-release probe rule, the probe skip and require flags, the migration-failure exit before any recreate or tag, the public probe's HSTS requirement (matching max-age passes; a missing header or mismatched max-age is fatal and leaves latest and state untouched), and rollback without a backup. |
| `scripts/webhook-smoke.sh` | Webhook gate (`npm run smoke:webhook`): exercises `deploy/webhook.sh` against a stub `gh`; create and update paths (including a hook response without `config.secret`), the dry run, missing secret, localhost guard, and secret secrecy in output and argv. |
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
