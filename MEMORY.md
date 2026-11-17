# MEMORY.md

- **Last updated:** 2026-11-17
- **Project:** curved
- **Phase:** HTTP API and auth boundary complete (`LAS-148`), plus a working SPA prototype, the SSE realtime stream (`LAS-150`), the GitHub webhook with its branch helper (`LAS-151`), the SPA foundation ticket (`LAS-152`), the architecture contract (`LAS-168`, documentation only), the pure domain layer (`LAS-169`, no behavior change), and step 3's slices, ports plus the projects resource (`LAS-170`) then the issue lifecycle and read model on ports (`LAS-171`), agents, claims, review, comments, and blocking on ports (`LAS-172`), then labels, relations, and the GitHub use case on ports (`LAS-173`), then the inbound-adapter rewire, composition roots, and the import-direction gate (`LAS-174`), then the web layering (`LAS-175`), then the completion gate, boundary audit, and handoff (`LAS-176`), all with no behavior change; all six refactor steps, the architecture gate, and the completion handoff are complete. Toolchain, Postgres 18, migrations, the projects resource, the issues resource (atomic keys, append-only events), comment events with the full timeline read path, the transition graph with its actor matrix, token-authenticated agents with the one-active-issue fence, agent block with human unblock, the MCP server over stdio, the authenticated HTTP API with its SPA fallback, the React/Vite board, queue, detail, and palette, the SSE stream that refreshes them, the HMAC-verified GitHub webhook that moves issues from pull requests, and the routed board with its mobile status bar are live, and `LAS-155` adds the end-to-end acceptance gate (`npm run acceptance`).

## Current verified state

- Repository root: `/home/dietkyle/projects/curved`
- Stack: Node 26.2 running TypeScript directly via type stripping, ESM with explicit
  `.ts` import extensions, `pg`, TypeScript 5.9 strict no-emit typecheck.
- Startup path: `./scripts/init.sh` runs install, database, check, build.
  `--no-install` skips only install; the database step still runs.
- End-of-session gate: `./scripts/clean-state.sh`
- End-to-end acceptance gate: `npm run acceptance`
  (`bash scripts/acceptance.sh` -> `node scripts/acceptance.mjs`) runs the CLI
  lifecycle, the eight-tool MCP stdio handshake, `npm start` with HTTP plus SSE,
  a signed GitHub webhook with its replay, and a dependency-free Chromium/CDP
  browser leg at 390x844 against one throwaway
  `curved_acceptance_<pid>_<epoch>` database. It migrates that database, drops
  it afterward, and fails when a per-table digest of the default `curved`
  database changes. `--skip-browser` and `--keep` are the flags; screenshots are
  written under the system temp dir with run-scoped names. `scripts/db.sh` gained
  `--no-migrate` so the acceptance bootstrap never writes the default schema.
- Baseline: green, and `LAS-176` re-ran and recorded the full gate on
  2026-11-17. `./scripts/init.sh` and `./scripts/clean-state.sh` both pass;
  `npm run typecheck` covers server and web configs; `npm test` runs 195 tests
  on the Node test runner (189 behavior, 6 architecture);
  `architecture: ok (74 files)`; the vite build and the codegraph sync are
  green. The completion gate also re-exercised the real entry points and found
  no behavior change.
- Architecture contract: `ARCH.md` codifies target hexagonal layers (domain,
  application, inbound and outbound adapters, composition roots), rule ownership
  with bounded mirrors, ports and transactions, error translation, web layering,
  testing policy, and enforcement. Steps 1 and 2, plus all four of step 3's
  resource slices (`LAS-170` ports and the projects resource; `LAS-171` the issue
  lifecycle and read model; `LAS-172` agents, claims, review, comments, and
  block; `LAS-173` labels, relations, and the GitHub use case), then step 4
  with the step-6 import-direction gate (`LAS-174`), and step 5's web layering
  (`LAS-175`); all six steps are done, so no section carries target markers.
  `LAS-176` then re-ran the gates on 2026-11-17 and recorded them: init and
  clean-state green, 195 tests, 74 architecture files, the entry-point smokes,
  and no behavior change.
- Templates: `/home/dietkyle/projects/templates/ARCH.md` (111 lines) is the
  project-agnostic version of the same contract, listed as copy-first item 2 in
  that directory's `index.md`; `templates/AGENTS.md` now reads `ARCH.md` in its
  startup workflow and lists it under required artifacts. `templates/` is not a
  git repository, so those files are uncommitted. `LAS-177` tracks the wider
  template audit.
- Domain layer (`LAS-169`): `src/domain/` owns every pure rule and type, and
  `src/shared/status.ts` plus `src/errors.ts` are deleted. `status.ts` holds
  `STATUSES`, `PRIORITIES`, `EVENT_KINDS`, `ACTOR_TYPES`, the four string-union
  types, `DEFAULT_STATUS`, `DEFAULT_PRIORITY`, `isStatus`, `isPriority`, and
  `isActorType`, and imports nothing. `transition.ts` holds `TRANSITIONS`,
  `StatusEdge`, `LEGAL_EDGES` (every legal edge, derived from `TRANSITIONS`) and
  `isLegalTransition`. `actors.ts` holds `ACTOR_TRANSITIONS` (its `human` row is
  `LEGAL_EDGES`), `actorMayTransition`, `TransitionContext`, `allowedTransitions`,
  `IssueContext`, `ResolvedContext`, `resolveContext`, and `validateActor`.
  `claim.ts` holds `nextClaimedBy`; `move-policy.ts` holds `mayMove`; `keys.ts`
  holds `PROJECT_KEY_PATTERN`, `ISSUE_KEY_PATTERN`, `ISSUE_KEY_IN_TEXT`,
  `BRANCH_SLUG_MAX_LENGTH`, `parseIssueKey`, `issueKeyFromText`, and
  `branchNameForIssue`; `validation.ts` holds every field validator and the
  constants `TITLE_MAX_LENGTH` 500, `PROJECT_NAME_MAX_LENGTH` 200,
  `AGENT_NAME_MAX_LENGTH` 100, `LABEL_NAME_MAX_LENGTH` 50, and
  `BLOCKED_REASON_MAX_LENGTH` 2000; `errors.ts` holds `ERROR_CODES`, `ErrorCode`,
  and `ServiceError`; `types.ts` holds `Issue`, `Project`, `Agent`, `CreatedAgent`,
  `IssueEvent`, `IssueMeta`, `IssueRelations`, and `emptyMeta`.
  `src/http/errors.ts` owns `HTTP_STATUS`, `httpStatusFor`, `ErrorBody`, and
  `errorBody`. The use cases in `src/application/` keep the orchestration and
  import every rule from the domain, while the SQL lives in
  `src/adapters/postgres/repositories/`; the issue use cases live in
  `src/application/issues.ts`, and `toIssue`/`hydrateIssue` live in
  `src/application/issue-read-model.ts` over `IssueRecord`. `src/domain/**` imports
  only domain modules: no `pg`, no `node:*`, no HTTP/MCP/CLI, no filesystem, no
  crypto, no React.
- Application boundary (`LAS-170`): `src/application/ports.ts` owns
  `ProjectRepository` (`create`, `list`, `findByKey`), `TokenCodec` (`mint`,
  `hash`), `ActiveClaimConflict`, `TransactionPorts` (`projects`, `tokens`), and
  `Ports` (`TransactionPorts` plus `transaction(fn)`). Ports carry no pg types.
  `TransactionPorts` has no `transaction` member, so a nested transaction cannot
  type-check. `src/application/projects.ts` holds `createProject(ports, input)`
  (key validated, then name) and `listProjects(ports)`; neither file imports `pg`,
  `src/db.ts`, or `node:*`. Later slices extend `TransactionPorts` through
  issues, events, meta, agents, and tokens (`LAS-171`, `LAS-172`) to `labels` and
  `relations` (`LAS-173`), so the label, relation, and GitHub writes are
  port-bound too.
- Postgres adapter (`LAS-170`): `src/adapters/postgres/repositories/projects.ts`
  implements the project port (insert with `23505` mapped to
  `ServiceError("duplicate", 'project key "<key>" already exists')`, `list`
  ordered by key asc, `findByKey` returning `null` when absent);
  `src/adapters/postgres/ports.ts` exports `createPorts(database)`, binding the
  repository and codec either to the pool or to `database.tx`'s connection. The
  cardinally one token implementation is `src/adapters/token-codec.ts`
  (`createTokenCodec()`: `crv_` plus 24 random bytes base64url, lowercase SHA-256
  hex); `createAgent` and `authenticateAgent` use it through `TokenCodec`, and
  `src/services/agents.ts` is gone, together with its `generateAgentToken` and
  `hashAgentToken` exports. `bindPorts` also binds the issue, issue-event,
  issue-meta, agent, label, and relation repositories added by `LAS-171` to
  `LAS-173`.
- Wiring (`LAS-170`): `createApp` requires a `ports: Ports` option;
  `src/server.ts` and the CLI `project add`/`project list` branches build
  `createPorts(db)`; `src/services/projects.ts` is deleted. `test/helpers/db.ts`
  exposes `TestDatabase.ports`. Duplicate, validation, ordering, payload, and
  output text are unchanged; only import paths and wiring moved.
- Issue ports (`LAS-171`): `src/application/issues.ts` holds the SQL-free use
  cases `createIssue`, `listIssues`, `getIssue`, `getIssueTimeline`,
  `updateIssue(ports, input)`, and `moveIssue(ports, input)`;
  `src/application/issue-read-model.ts` holds `toIssue` (derives
  `allowedTransitions`) and `hydrateIssue`. `src/application/ports.ts` also
  declares `IssueRecord`, `LockedIssueRecord`, `IssueRepository` (create with the
  atomic per-project allocation, findById, findByKey, lockByKey, list,
  updateFields, updateStatus, findActiveClaimKey, listReady),
  `IssueEventRepository` (append, list ascending id), `IssueMetaRepository`
  (loadForIds, at most two statements), and `AgentRepository` (the full port,
  landed with `LAS-172`), and `TransactionPorts` carries
  projects/issues/events/meta/agents/tokens.
  Adapters are `src/adapters/postgres/repositories/issues.ts`, `issue-events.ts`,
  `issue-meta.ts`, and `agents.ts`; `src/adapters/postgres/ports.ts` exports
  `bindPorts(db: Db): TransactionPorts`, and `createPorts(database)` delegates to
  it. `src/services/issues.ts`, `events.ts`, and `issue-meta.ts` are deleted, and
  the GitHub webhook enters through `bindPorts` and the application modules. Then
  still transitional, retired by `LAS-173`: `labels` and `relations` owned their
  table SQL, and `github.ts` carried the GitHub use case itself. An
  `issues_one_active_claim_per_agent` violation in `updateStatus` becomes the
  port-level `ActiveClaimConflict`, which `moveIssue` and `claimNext` map to the
  unchanged `agent_busy` message naming the active key. `listIssues` stays three
  statements; payloads, error codes, and all 189 tests are unchanged.
- Agent and queue ports (`LAS-172`): `src/application/agents.ts` holds
  `createAgent(ports, name)`, `authenticateAgent(ports, token)`, and
  `ensureAgentExists(ports, name)`, with token mint and hash behind `TokenCodec`.
  `src/application/queue.ts` holds `ReadyQueue`, `listReady(ports, options?,
  context?)`, `claimNext(ports, options, agent)`, `submitForReview(ports, input)`,
  and `releaseClaim(ports, input)`; `src/application/blocking.ts` holds
  `blockIssue(ports, input)` and `unblockIssue(ports, input)`;
  `src/application/comments.ts` holds `commentOnIssue(ports, input)`. None of them
  imports `pg`, `src/db.ts`, or `node:*`. `AgentRepository` is now `create({ name,
  tokenHash })`, `findByTokenHash(tokenHash)`, `findByName(name)`, and
  `acquireClaimLock(name)`; the old `exists` is gone. `IssueRepository` adds
  `block({ id, reason })`, `unblock({ id })`, and `lockClaimCandidate({ project
  })` (todo, unblocked, no not-done blocker, priority/number/key order, `for
  update ... skip locked`); `updateStatus`, `findActiveClaimKey`, and `listReady`
  are unchanged. `src/adapters/postgres/repositories/agents.ts` implements all
  four agent operations, maps SQLSTATE `23505` to `ServiceError("duplicate",
  'agent "<name>" already exists')`, and owns the advisory lock
  `select pg_advisory_xact_lock(727275, hashtext($1))`;
  `src/adapters/postgres/repositories/issues.ts` owns the skip-locked candidate
  query and the single-statement block and unblock updates.
  `src/services/agents.ts`, `queue.ts`, `blocking.ts`, and `comments.ts` are
  deleted, leaving `github.ts`, `labels.ts`, and `relations.ts` as the last three
  service modules at that point, all deleted by `LAS-173`. Wiring: HTTP
  `resolveActor(request, { ports, uiToken })`, with
  `src/http/app.ts` passing `ports` to the comment, block, unblock, release,
  ready, and claim routes and keeping `db` only for labels, relations, and the
  event hub at that point; the CLI builds `createPorts(db)` once per
  `withDatabase` scope and uses `withAgent(ports, config, fn)`; MCP `ToolDeps` is
  `{ ports, resolveAgent }` (the `db` field is gone) with
  `resolveAgentFromToken(ports, config)`. Behavior is unchanged: same error codes
  and messages, same events, same concurrency semantics, and 189 passing tests.
- Label, relation, and GitHub ports (`LAS-173`): `src/application/ports.ts` adds
  `LabelRepository` (`replace({ issueId, projectId, names })`: upsert the
  project's label rows, then replace the issue's set) and `RelationRepository`
  (`add({ blockingIssueId, blockedIssueId })`: idempotent insert, true only when
  a row was created); `TransactionPorts` carries
  projects/issues/events/meta/agents/labels/relations/tokens.
  `src/application/labels.ts` holds `setIssueLabels(ports, input)`,
  `relations.ts` holds `addRelation(ports, input)`, and `github.ts`
  holds `applyPullRequestEvent(ports, event, payload)`; none imports `pg`,
  `src/db.ts`, or `node:*`. Adapters are
  `src/adapters/postgres/repositories/labels.ts` (`createLabelRepository`, the
  same three statements) and `relations.ts` (`createRelationRepository`, the same
  idempotent insert), both bound in `bindPorts`. `src/services/` is deleted,
  including `labels.ts`, `relations.ts`, and `github.ts`, with no re-export
  shims. `src/http/webhook.ts` keeps HMAC verification, the raw-body read, the
  1 MiB body cap, JSON parsing, and the non-POST 404, and calls the use case;
  `createApp` no longer accepts `db` (the label and relation routes take
  `ports`), and `src/server.ts` plus six test files were updated by import and
  wiring only. `src/db.ts` still owns the pool, `Db`/`Database`, transactions,
  and the pg error helpers, and every repository still takes a `Db`. Behavior is
  unchanged: 189 tests pass.
- Web layer map (`LAS-175`): step 5 splits `web/src` into four layers plus a
  composition root. `web/src/domain/` is pure: `types.ts` holds `Actor`,
  `Project`, `Issue`, `IssueEvent`, `IssueTimeline`, `ReadyQueue`,
  `ProjectList`, `NewIssueInput`, `ToastKind`, and `ToastItem` and imports only
  `ActorType`, `EventKind`, `Priority`, and `Status` from
  `src/domain/status.ts` (the single backend module web code may import);
  `presentation.ts` holds the status, priority, and event label and tone maps,
  `STATUS_ORDER`, `initials`, `matchesQuery`, `sortForColumn`, `countByStatus`,
  `relativeTime`, `absoluteTime`, and `eventDetail` over `STATUSES` from the
  same contract; `routes.ts` holds `Route`, `parseRoute`, `boardPath`,
  `queuePath`, `issuePath`, and `newIssuePath` with no React, `window`, or
  `history`. `web/src/application/` is React hooks with no JSX: `errors.ts`
  holds `ApplicationError` (status, code, message), `isApplicationError`,
  `isUnauthorized`, and `messageOf`, the one application error type;
  `ports.ts` holds `ApiPort` (me, signIn, signOut, projects, createProject,
  issues, issue, ready, createIssue, updateIssue, transition, comment,
  setLabels, addRelation, unblock), `RealtimePort` (`useIssuesChanged`),
  `NavigationPort` (`route`, `navigate(path, { replace? })`), and
  `IssuesChangedOptions`; `workspace.ts` holds `AuthState`, `WorkspaceDeps`,
  `Workspace`, and `useWorkspace` with all orchestration from the deleted
  `app.tsx` (session check, project load and selection, the replace-redirect for
  unknown projects, issue and ready load with the focus refresh and per-project
  cache, the realtime subscription, timeline load, the `Ctrl/Cmd+K` listener,
  and one `run` helper for actions with the 401 reset and toasts capped at
  three), importing only `react`, `../domain/*`, `./ports.ts`, and
  `./errors.ts`, with no JSX, `fetch`, `EventSource`, or history write.
  `web/src/adapters/` holds `api-client.ts` (`createApiClient(): ApiPort` over
  `fetch` with the same paths, verbs, and bodies, a network failure becoming
  `ApplicationError(0, "network", ...)` and a non-ok response
  `ApplicationError(status, code, message)`), `realtime.ts` (`useIssuesChanged`
  plus `realtime: RealtimePort`, one `EventSource` on `/api/events`,
  `issues_changed` frames filtered by project id, reconnect after 1s), and
  `history.ts` (`useHistoryRouter(): NavigationPort` plus `NAVIGATE_EVENT`,
  `pushState`/`replaceState` and `popstate`, dispatching a `navigate`
  `CustomEvent`). `web/src/ui/` is React and styles only: `AppView.tsx` renders
  the whole shell and every gate from one `workspace` prop, `Boot.tsx` holds the
  boot screen and boot error card, and no component imports `fetch`,
  `EventSource`, `history`, or an adapter; `SignIn` takes
  `onSignIn(token): Promise<void>` and reports `ApplicationError.message`
  inline, and `ProjectSetup` takes `onCreate(input): Promise<Project>` plus
  `onCreated` and `onSignOut`. `web/src/main.tsx` is the composition root: it
  creates the fetch client, calls the history and realtime adapter hooks,
  injects the API, realtime, and navigation ports into `useWorkspace`, and
  renders `AppView`; it is the only module importing both `ui` and
  `application` and the only one constructing adapters. `web/src/app.tsx`,
  `web/src/lib/`, `web/src/components/`, and the root `web/src/styles.css` are
  deleted with no shims. Behavior is unchanged: same copy, palette, breakpoints,
  palette colors, self-hosted fonts, and interactions.
- Web gates and smoke (`LAS-175`): `npm run typecheck` green; `npm run
  check:arch` printed `architecture: ok (74 files)`; `npm run build` green;
  `npm test` 195 pass, 0 fail (189 behavior plus 6 architecture), with
  `test/architecture.test.ts` proving the real tree passes and five fixture
  trees fail (application -> adapter, domain -> `pg`, web ui -> adapter, web
  application -> adapter, web domain -> backend module). Browser smoke in
  Chromium: 390x844 (five-status bar with 44 px targets, 56 px bottom nav, card
  list with 120 px bottom scroll padding, per-status counts) and 1440x900
  (236 px sidebar, five flex columns, `overflow-x: auto`); sign-out; sign-in
  with a rejected and an accepted token; first-run project setup on a throwaway
  database (validation message, create, toast, empty board), dropped afterward;
  board; ready queue; issue detail transition and comment; `Ctrl/Cmd+K` palette;
  cross-tab SSE where a CLI comment and a CLI-created issue appeared in both
  open tabs without reload. No console errors.
- Database: `docker compose up` starts `postgres:18-alpine` on host port 55432
  (user/password/db all `curved`, named volume mounted at `/var/lib/postgresql`).
  `scripts/db.sh` waits for readiness, then runs `node src/migrate.ts`.
- Migrations: `migrations/*.sql` applied lexicographically under session advisory
  lock 727274, one transaction per file, with a `schema_migrations` ledger.
  Concurrent first runs are serialized and covered by a regression test.
- Schema: `projects` (identity id, unique key matching `^[A-Z][A-Z0-9]{1,9}$`,
  trimmed name 1..200, `next_number` default 1).
- Schema: `issues` (project reference, per-project `number`, globally unique `key`
  matching `^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$`, trimmed title 1..500, description,
  status, priority 1..4, optional parent, blocked reason, and claimer, timestamps;
  unique `(project_id, number)`), plus append-only `issue_events` (kind, actor type,
  optional from/to statuses and body; a row trigger rejects every UPDATE and DELETE
  with SQLSTATE 23001).
- CLI: `node src/cli.ts project add <KEY> <name...>`, `project list`, `migrate`,
  `issue add <PROJECT> <title...>`, `issue list [PROJECT]`, `issue show <KEY>`
  (renders the full timeline), `issue comment <KEY> <body...> [--actor <type>]`,
  `issue move <KEY> <status> [--body <text>] [--actor <type>] [--agent <name>]`
  (human output `moved <KEY> to <status>`, `--json` prints the issue payload),
  and `--json`; errors print `<code>: <message>` and exit 1.
- Transitions: the graph is `backlog -> todo`, `todo -> in_progress`, `todo ->
  backlog`, `in_progress -> in_review`, `in_progress -> todo`, `in_review -> done`,
  `in_review -> in_progress`, `done -> todo`. Actors: `human` may take any
  legal edge; `git` may take `in_progress -> in_review` and `in_review -> done`;
  `system` takes none; `agent` may claim unclaimed `todo -> in_progress` with a
  named agent, then only its owned `in_progress -> in_review` or `in_progress ->
  todo`.
- Claims: `claimed_by` is set when an agent claims into `in_progress`, kept through
  `in_review` and `done`, and cleared on `todo` and `backlog`.
- Every issue payload from `createIssue`, `getIssue`, `listIssues`,
  `getIssueTimeline`, and `moveIssue` carries `allowedTransitions`.
- `moveIssue` locks the issue row by key (`SELECT ... FOR UPDATE`) inside one
  transaction, checks the legal edge then the actor gate, applies the claim-column
  rules, and writes exactly one `status` event with from/to, actor, and optional
  body before returning the hydrated issue.
- Comments are `issue_events` rows of kind `comment`; there is no comments table.
  Bodies are trimmed and empty/whitespace-only bodies fail with `validation`.
  Timeline reads order by ascending event id; timestamps are display only.
- Issue keys are canonical without padding (`TAC-14`); parsing accepts padded input
  such as `TAC-014`.
- Schema: `agents` (identity id, unique trimmed name 1..100, unique lowercase
  SHA-256 hex `token_hash`, created_at). `issues.claimed_by` references
  `agents(name)`. The partial unique index `issues_one_active_claim_per_agent`
  allows one row per `claimed_by` where status is `in_progress` or `in_review`;
  the fence is per agent and global across projects. `done` keeps `claimed_by` as
  history but is not active.
- Agent tokens: `crv_` plus 24 random bytes base64url (36 chars). `agent add <name>`
  prints the token once and stores only its SHA-256 hex; a duplicate name fails with
  `duplicate`. `authenticateAgent` hashes the presented token and resolves by
  `token_hash`; blank and unknown tokens both fail `not_authenticated`.
- CLI: `agent add <name> [--json]`, `ready [PROJECT] [--human]`, `claim [PROJECT]`,
  `review <KEY> <summary...>`, `release <KEY>`, and `issue block <KEY> <reason...>`.
  `ready` without `--human`, plus `claim`, `review`, `release`, and `issue block`,
  read `CURVED_AGENT_TOKEN`; an absent or invalid token fails
  `not_authenticated` and never falls back to the human actor. `ready`
  JSON is `{ ready, busy }`; human output lists
  `<key>\t<priority>\t<status>\t<title>` then `busy: <key>` or `busy: -`.
  `issue list` prints a fifth column: the blocked reason or `-`.
  `issue comment` accepts `--agent <name>`; `issue move --agent` now requires a
  registered agent name.
- Ready queue: `listReady` returns `todo` issues with no blocked reason, optionally
  scoped to a project, ordered by priority then number then key, plus the caller's
  active claim key (`null` for humans).
- Claiming: `claimNext` takes `pg_advisory_xact_lock(727275, hashtext(agent))` so
  concurrent claims by one agent serialize, pre-checks the active claim for
  `agent_busy`, then selects one candidate with
  `order by priority, number, key limit 1 for update skip locked`, sets
  `in_progress` and `claimed_by`, and appends one `claim` event (`todo ->
  in_progress`). Different agents compete through `skip locked`; two agents racing
  one ready issue produce one claim and one `no_ready_issue`. A partial-index
  violation is mapped to `agent_busy` naming the active key.
- Review and release: `submitForReview` requires ownership and `in_progress`, writes
  one `review_submitted` event (`in_progress -> in_review`) with the trimmed summary
  as body, and keeps the claim. `releaseClaim` requires ownership and
  `in_progress`, returns the issue to `todo`, clears `claimed_by`, and writes one
  `release` event. Both reject non-owners with `forbidden_transition` and wrong
  statuses with `illegal_transition`.
- Blocking: `blockIssue` requires the agent's own `in_progress` issue, trims a 1..2000
  character reason, sets status `todo`, clears `claimed_by`, stores `blocked_reason`,
  and appends one `blocked` event (`in_progress -> todo`, body = reason). Wrong status
  is `illegal_transition`, another agent's or an unclaimed issue is
  `forbidden_transition`, and an empty or too-long reason is `validation`.
  `unblockIssue` is human only (`forbidden_transition` for every other actor),
  requires a non-null `blocked_reason` (`validation` otherwise), clears it, and
  appends one `unblocked` event without touching status or claim. `issue unblock`
  accepts `--actor`/`--agent` so the rejection is reachable from the CLI, but
  defaults to human. Blocked issues are absent from `listReady` and `claimNext`
  (`no_ready_issue`) and reappear after unblock.
- MCP: `npm run mcp` (`node src/mcp/main.ts`) serves the v2
  `@modelcontextprotocol/server` (2.4.0) over stdio via `serveStdio`, registering
  exactly `claim_next`, `comment`, `create_issue`, `get_issue`, `list_ready`,
  `mark_blocked`, `release_claim`, and `submit_for_review`. Handlers are thin over
  the application layer and never run SQL. Every call authenticates
  `CURVED_AGENT_TOKEN` (`not_authenticated` names the variable when blank or
  unknown) and acts as actor `agent` with that agent's name. Inputs are
  zod-validated; the SDK returns schema failures as `isError` text results
  beginning `Input validation error: Invalid arguments for tool ...`.
  Successful payloads are pretty-printed JSON in one text block; `ServiceError`
  becomes `<code>: <message>` with `isError: true`. `list_ready` returns
  `{ ready, busy }`; `claim_next` and `get_issue` return `{ issue, events }`;
  `create_issue`, `submit_for_review`, `release_claim`, and `mark_blocked` return
  the issue; `comment` returns the appended event. stdout carries protocol only;
  diagnostics go to stderr. The process closes the database and exits when stdin
  ends or on SIGINT/SIGTERM.
- Comment ownership: an agent cannot comment on an issue claimed by another agent
  (`forbidden_transition`); the owner, humans, and comments on unclaimed issues are
  allowed. An agent actor requires a registered identity (`validation` when absent,
  `not_found` when unknown).
- `EVENT_KINDS` includes `review_submitted`, `blocked`, and `unblocked`; the database
  check constraint mirrors it. `moveIssue` still writes kind `status`; the queue
  tools write `claim`, `review_submitted`, and `release`; `blockIssue` and
  `unblockIssue` write `blocked` and `unblocked`.
- HTTP: `src/server.ts` (npm script `start`, and `scripts/init.sh`'s `START_CMD`)
  reads `PORT` (default 4747), requires `CURVED_UI_TOKEN`, and exits 1 with
  `CURVED_UI_TOKEN is required to start the HTTP server` when it is absent.
  `createApp({ db, ports, uiToken, webDistDir?, logger? })` returns
  `{ handle(request: Request): Promise<Response> }`, so tests drive the real router
  in-process. A `Bearer` equal to `CURVED_UI_TOKEN` is the human actor; any other
  bearer goes through `authenticateAgent` and becomes an agent actor with its name;
  the `curved_session` cookie (lowercase SHA-256 hex of the UI token,
  `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`) also identifies the human. A
  present but invalid bearer is `401 not_authenticated` even with a valid cookie.
  No CORS headers are emitted.
- HTTP routes: `GET /api/me`; `POST`/`DELETE /api/session` (POST takes the UI token
  in a `{ token }` body and sets the cookie; DELETE requires auth); `GET`/`POST
  /api/projects` (GET requires a human or agent; create is human only); `GET`/`POST
  /api/issues` (list filters on `project` and `status`); `GET`/`PATCH
  /api/issues/:key` (PATCH is human only:
  title, description, priority); `POST /api/issues/:key/transition | comments |
  block (agent) | unblock (human) | release (agent)`; `GET /api/ready` (any
  authenticated actor); `POST /api/claims/next` (agent). Payloads are wrapped as
  `{project}`, `{projects}`, `{issue}`, `{issues}`, `{issue,events}`, `{event}`,
  `{ready,busy}`, and `{actor}`. Mutating requests with a body require a
  `Content-Type: application/json` header (`validation` otherwise); an empty body
  reads as `{}`. Errors are `{ error: { code, message } }`: 400 `validation`, 401
  `not_authenticated`, 403 `forbidden_transition`, 404 `not_found`, 409 for the
  other service codes (`agent_busy`, `duplicate`, `illegal_transition`), 500
  `internal` with the detail logged. Unknown `/api` paths return JSON 404.
- HTTP SPA fallback: non-`/api` `GET`/`HEAD` serves `web/dist` (default) as a
  matching file or `index.html`; the document is `cache-control: no-cache` and
  `/assets/*` is `public, max-age=31536000, immutable`. With no build the response
  is a 503 text naming `web/dist` and the build command; `/api` never falls back
  to HTML.
- Webhook: `POST /webhooks/github` is handled in `src/http/webhook.ts` and routed
  in `createApp`'s `handle` before the `/api` branch, so it never resolves a
  session or a bearer. `githubSignature` returns `sha256=<hmac hex>`; the raw body
  is read once with `request.text()` and compared via `constantTimeEqual` before
  `JSON.parse`, and a body over 1 MiB is `validation`. A blank
  `GITHUB_WEBHOOK_SECRET` (config field `webhookSecret`, passed by `server.ts`) is
  `503 webhook_not_configured`; a missing or wrong `x-hub-signature-256` is
  `401 not_authenticated`; malformed JSON is `400 validation`.
- Webhook mapping: `applyPullRequestEvent(ports, event, payload)` returns null unless
  the `x-github-event` header is `pull_request`. The action resolves from the
  top-level `payload.action` first, then `pull_request.action`; `opened` and
  `reopened` target `in_review`, `closed` targets `done` only when
  `pull_request.merged === true`, and everything else is ignored. The key comes
  from `head.ref` first and the pull request title second through
  `issueKeyFromText` (the first `ABC-123` match, normalized unpadded). Moves run
  through `moveIssue` with actor `git` and body `pull request #<n> <action>`, so
  the transition graph and actor matrix still gate them; `not_found`,
  `illegal_transition`, and `forbidden_transition` fold into an ignored response,
  which is what makes replays harmless. Applied deliveries answer
  `200 {"ok":true}`; everything ignored answers `200 {"ok":true,"ignored":true}`.
- Branch helper: `issueKeyFromText` and `branchNameForIssue` (canonical key plus
  a 60 character title slug) live in `src/domain/keys.ts`; the `git-branch`
  command reads the issue as a human and the GitHub use case reads the key from
  the pull request through them. The CLI `git-branch <KEY> [--json]` prints
  `<key>-<slug>`, or `{ key, branch }` with `--json`; an unknown key exits 1 with
  `not_found`.
- Schema (LAS-150): migration `0005_issue_notifications.sql` installs
  `notify_issue_change()`, which fires `after insert` and `after update` on
  `issues` and `after insert` on `issue_events`, calling
  `pg_notify('issues_changed', project_id::text)` for the owning project.
- Event hub: `src/http/event-hub.ts` opens one `pg.Client` lazily per app, runs
  `LISTEN issues_changed`, parses numeric project ids, and fans them out to
  subscribers. It reconnects once after 1s while subscribers remain and exposes
  `stats()` and `close()`. Postgres shows exactly one LISTEN backend per process.
- SSE: `src/http/sse.ts` serves `/api/events` as `text/event-stream; charset=utf-8`
  with `cache-control: no-cache, no-transform` and `x-accel-buffering: no`. Frames
  are `ready` after the hub subscription exists, `issues_changed` with the project
  id as `data`, and `ping` every 25 seconds. Request abort or consumer cancel
  clears the ping interval and subscription once.
- SSE auth: `resolveSessionActor` authenticates `/api/events` by the
  `curved_session` cookie only and ignores `Authorization`, because `EventSource`
  cannot set request headers. No cookie or a bearer-only request is
  `401 not_authenticated` JSON.
- `createApp` now requires `databaseUrl`; it creates and owns the hub when none is
  injected, and `close()` shuts the owned hub down. `src/server.ts` streams
  event-stream responses chunked with backpressure instead of buffering, gives
  each request an `AbortSignal` aborted on client disconnect, and closes the
  app/hub and all connections on shutdown.
- Web realtime: `web/src/adapters/realtime.ts` opens one `EventSource("/api/events")`,
  filters `issues_changed` by the current project id, refreshes the board and open
  issue detail, and reconnects 1s after error or close with a single-timer guard.
  The 20 second poll is removed; the window `focus` refresh and manual refresh
  remain.
- Application additions for the HTTP slice: `listIssues` accepts `{ project?,
  status? }`; `updateIssue(ports, { key, title?, description?, priority?, actor?,
  agent? })` is human only (`forbidden_transition` otherwise), requires at least one
  field, trims the title, validates priority, appends no timeline event (no event
  kind exists for field edits), and returns the hydrated issue with
  `allowedTransitions`.
- Schema (LAS-149): `labels` (per-project unique trimmed name 1..50),
  `issue_labels` link table keyed `(issue_id, label_id)`, and `issue_relations`
  directed edges keyed `(blocking_issue_id, blocked_issue_id)` with a no-self
  check and a `blocked_issue_id` index. Migration `0004` adds only the tables:
  the `labels` and `relation` event kinds were already in the 0002/0003
  constraint.
- Labels: `setIssueLabels(db, { key, labels, actor?, agent? })` is human only,
  trims and dedupes names, upserts them into the issue's project, rewrites the
  issue's link rows, appends one `labels` event whose body is the JSON
  `{"labels":[...]}` (sorted; an empty array clears the set and still records one
  event), and returns the hydrated issue. `POST /api/issues/:key/labels` wraps it
  (`{ labels }`, human only, 200 `{ issue }`).
- Relations: `addRelation(db, { blocked, blocking, actor?, agent? })` is human
  only, resolves both keys before writing (`not_found` names the missing key),
  rejects self-edges with `validation`, inserts with `on conflict do nothing`
  (duplicates append no second event), appends one `relation` event on the blocked
  issue with body `{"blocking":...,"blocked":...}`, and returns the hydrated
  blocked issue. `POST /api/issues/:key/relations` wraps it (`{ blocking }`, where
  `:key` is the blocked issue; human only, 200 `{ issue }`).
- Issue payloads carry `labels: string[]` and
  `relations: { blocks, blockedBy }` (keys, both ascending) on every hydration
  path, including move, block, release, and review.
  `src/adapters/postgres/repositories/issue-meta.ts` (`IssueMetaRepository`)
  loads both directions for a batch in two statements; `listIssues` is exactly
  three statements for a non-empty project list (issues, labels, relations), with
  no per-issue query and no lateral aggregate, and runs an existence check only
  when a filtered list comes back empty.
- Ready: `listReady` and `claimNext` exclude a `todo` issue while any issue
  blocking it is not `done`; it reappears in the queue and becomes claimable once
  the blocker reaches `done`.
- Web: `web/` is a Vite 8 + React 19 + TypeScript SPA using Tailwind v4, Motion,
  and Phosphor. `npm run build` runs the typechecks and then writes `web/dist`;
  `npm start` serves that build; `npm run dev` runs Vite on 5173 with `/api`
  proxied to 4747. `tsconfig.web.json` typechecks `web/src` only, so
  `web/vite.config.ts` is validated by Vite at build time.
- Web surface: sign-in with `CURVED_UI_TOKEN`, first-run project setup, five-lane
  board with desktop drag-to-move gated by each issue's `allowedTransitions`,
  mobile status list, ready queue with claim order, in-flight agents and human
  unblock, issue detail as a centered modal with timeline, comment composer, field
  edits, label replacement, blocking relations and unblock, and a `Ctrl/Cmd+K`
  palette. The shell is `fixed inset-0`; sign-in and setup scroll normally. Data
  refreshes on mutation, window focus, manual refresh, and the `/api/events`
  stream; the 20 second visible-tab poll was removed in `LAS-150`.
- Web design: fixed warm near-black palette (`canvas`, `panel`, `elevated`,
  `line`, parchment text, spice primary, semantic status accents), Instrument Sans
  + JetBrains Mono, one 5 px radius, no light mode. The visual verification matrix
  covered 1440, 1024, and 390 px; text contrast was audited and returned no
  failures; there are no em dashes.
- Tests: isolated database from `TEST_DATABASE_URL` (name must start with
  `curved_test`), created and migrated by `test/helpers/db.ts`; its reset truncates
  `projects` and `agents` with cascade. The development database is never touched.
  `npm test` runs 195 tests, including 22 agent/queue tests in
  `test/agents.test.ts`, the projects suite in `test/projects.test.ts` (create,
  list ordering, duplicate and validation errors, transaction-scoped commit and
  rollback, repository find-by-key), 13 MCP-over-stdio tests in
  `test/mcp.test.ts`, the
  blocking suite in `test/blocking.test.ts`, the HTTP suite in `test/http.test.ts`,
  the label and relation suites in `test/labels.test.ts` and
  `test/relations.test.ts`, the event hub and SSE suites in `test/event-hub.test.ts`
  and `test/sse.test.ts`, the webhook and branch helper suite in
  `test/github.test.ts`, the transition suite, comment ownership tests, and the
  CLI sequence.
- Git repository on branch `main`, remote `origin`
  (`https://github.com/DietKyle956/Curved.git`), public on GitHub.
- Index: `.codegraph/` initialized, gitignored.

## Decisions

- Stack: TypeScript + Node.js (from `initial_idea.md`). Mobile-first UI, agent-first API.
- The state machine and agent tool interface are the product; the board is a client.
- Postgres is the store: issues, relations, labels, comments, `issue_events`, plus a
  partial unique index for one `in_progress` issue per project/agent.
- Issue creation allocates the number with one CTE statement that updates
  `projects.next_number` and inserts the row; the `created` event is appended in the
  same transaction, so a created issue never lacks history.
- `src/domain/status.ts` is the single contract for statuses, priorities, event
  kinds, and actor types; the schema constraints mirror it.
- `src/domain/transition.ts` and `src/domain/actors.ts` are the single home of the
  graph and the matrix (`TRANSITIONS`, `LEGAL_EDGES`, `ACTOR_TRANSITIONS`,
  `isLegalTransition`, `actorMayTransition`, `allowedTransitions`). The agent claim
  edge (`todo -> in_progress`, unclaimed, named agent) is included because the
  claim-column rule must be reachable; every other agent edge requires ownership.
  `system` actors take no transitions. `allowedTransitions` and `TransitionContext`
  live in `actors.ts` next to the matrix they are built from, so `transition.ts`
  never imports the matrix, and `ACTOR_TRANSITIONS.human` is derived from
  `TRANSITIONS` through `LEGAL_EDGES` instead of a second edge list; that is what
  keeps the domain import graph acyclic.
- `issues.claimed_by` references `agents(name)` (`LAS-145`). Migration `0003`
  backfills pre-fence names with unusable random hashes and demotes duplicate active
  claims before adding the FK and the partial unique index; the service maps the
  index violation to `agent_busy`.
- The claim fence is per agent and global across projects, over `in_progress` and
  `in_review`; `done` is not active, so a completed issue frees the agent. The
  unique index is the real fence; the pre-check exists to name the busy key.
- `claimNext` serializes same-agent claims with advisory lock namespace 727275 so
  the losing concurrent claim sees the committed claim and gets `agent_busy`.
  Different agents use `skip locked`, which yields `no_ready_issue` for the loser.
- Agent commands never infer an actor from a missing token: `ready` requires
  `--human` for the human view, and `claim`/`review`/`release` require a valid
  token. Tokens are minted once and only hashed at rest.
- `review_submitted` is a distinct event kind from `status`: the queue tools record
  the tool-level action, while `issue move` remains the generic status path.
- Blocking is a reason plus `todo`, not a sixth status (`LAS-146`). `blocked` and
  `unblocked` are distinct event kinds like `review_submitted`: `blocked` records the
  status move (`in_progress -> todo`) plus the reason, `unblocked` records no status
  change. Claim ownership gates blocking; the human actor gates unblocking.
- Relations are blocking-only directed edges (`LAS-149`), shaped as
  `relations: { blocks, blockedBy }` to match Linear's vocabulary: `blocks` points
  out, `blockedBy` points in. Labels are per project, so an issue can only carry
  its own project's labels. Replacing an issue's labels rewrites `issue_labels`
  wholesale; label rows are never deleted, and the event body is the full sorted
  set. Cycles are recorded as given: readiness only asks whether a blocker is
  `done`, so a cyclic pair stays out of `ready` until a human breaks it.
- The label and relation writes are human-only HTTP surfaces, not new CLI verbs
  or MCP tools: agents consume the results through the issue payload and the
  dependency-aware ready queue.
- Realtime notifications are refetch hints, not payloads: `issues_changed` carries
  only the numeric project id and the client decides what to reload. A row trigger
  rather than a service hook keeps Postgres as the source of truth, so writes from
  any entry point notify.
- Issue updates notify through the `issues` row trigger even when no timeline
  event kind exists, so a field edit still refreshes the board even though
  `updateIssue` appends no event.
- SSE auth is cookie-only because `EventSource` cannot set request headers; the
  stream is a human-board feature rather than part of the agent surface.
- One lazily opened shared LISTEN client per process with a guarded 1s reconnect
  while subscribers remain. `createApp` creates and owns the hub unless one is
  injected, in which case the caller owns it; `close()` shuts down only the owned
  hub.
- MCP targets the v2 `@modelcontextprotocol/server` 2.4.0 with `serveStdio`
  (default `legacy: "serve"`), not the v1 SDK: v2 serves the 2025 `initialize`
  handshake and the 2026 spec from the same factory, so no fallback was needed.
  `@modelcontextprotocol/client` is a dev dependency used only by the stdio test.
- MCP handlers live in `src/mcp/tools.ts` and are thin over the application
  layer; `src/mcp/server.ts` registers them and owns the token/database lifecycle;
  `src/mcp/main.ts` is the entry. Tool schemas are zod-only in the adapter; the
  application modules stay authoritative for business validation.
- Input-schema failures surface as `isError` results (`Input validation error:
  Invalid arguments for tool <name>: ...`), because the v2 SDK catches the
  InvalidParams throw inside the tools/call handler. Tests assert that shape.
- The MCP process exits when stdin ends (client disconnect) or on SIGINT/SIGTERM,
  closing the stdio transport and the pool once; `serveStdio` owns the transport.
- The transition rules live in `src/domain/transition.ts`,
  `src/domain/actors.ts`, and `src/domain/move-policy.ts` (`LAS-144`, extracted
  in `LAS-169`).
- Foundation sequence: shared contract modules (`config`, `db`, `errors`) land first,
  then disjoint slices for database, services/CLI, tests, and baseline/docs.
- Migrations take the session advisory lock before creating the ledger, so two
  concurrent first runs serialize instead of racing on `pg_type`.
- `web/` is a real Vite + React typecheck project. `npm run build` is the no-emit
  server typecheck plus the web typecheck plus the Vite build, so `web/dist` is
  always produced by the baseline.
- The SPA uses the server payload's `allowedTransitions` as the only drag-and-drop
  source of truth; it never re-implements the transition graph client-side.
- The app shell is fixed to the viewport and the board owns its horizontal scroll.
  The issue detail is a centered modal built on the shared `Modal` shell
  (`web/src/ui/Modal.tsx`): a dimmed blurred backdrop, a 768 px panel
  capped at `min(100dvh - 3rem, 50rem)` and rounded on `sm` and up, a full-screen
  sheet below `sm`, Escape and backdrop close, body scroll lock, focus taken on
  open and restored to the trigger on close, and a Tab cycle inside the panel.
  `Dialog` and the issue detail share that shell; the palette keeps its own
  overlay at a higher layer so Escape closes it before the detail.
- The GitHub webhook lives outside `/api` and outside both auth lanes: the HMAC of
  the raw body is the only credential, so a delivery needs no cookie and no
  bearer, and a valid HMAC with a bogus bearer still succeeds. Signature
  verification runs before parsing, so a forged body never reaches `JSON.parse`.
- Every webhook outcome that is not an applied move (unknown key, illegal or
  forbidden transition, replay, closed-unmerged pull request, non-`pull_request`
  event) returns `200 {"ok":true,"ignored":true}` rather than an error, because a
  non-2xx makes GitHub retry a delivery that could never succeed. Replays need no
  dedupe table: moving to the same status is already an illegal transition.
- Webhook moves use the existing `git` actor, transition graph, and actor matrix
  instead of a bypass path, so a pull request cannot claim work or move a `todo`
  issue straight to review.
- The action and number are read from the payload top level first (real GitHub
  shape) with `pull_request.action` and `pull_request.number` as fallbacks;
  `merged`, `head.ref`, and `title` stay inside `pull_request`.
- `git-branch` prints the canonical key plus a lowercased, 60 character title slug
  so the branch is readable by humans and parses back through `issueKeyFromText`.
- No frontend test framework was added for the prototype. Verification was a real
  Chromium pass against a live server at 1440, 1024, and 390 px, including sign-in,
  setup, empty project, create, comment, move, drag, label, relation, unblock,
  palette, browser back, and offline error states.

## Open questions

- None blocking. MCP transport is settled: stdio on the v2
  `@modelcontextprotocol/server` package, no v1 fallback.
- Blocking-relation cycles are permitted and simply keep the affected issues out
  of `ready`; no cycle detection was specified for `LAS-149`.
- Realtime limits: the hub keeps its single LISTEN client open after the last
  subscriber until app shutdown, and there is no frontend test framework, so
  browser coverage is a manual Chromium pass. `LAS-152`/`LAS-153`/`LAS-154` remain
  open until their acceptance tests land. The HTTP server answers non-`/api` paths
  with a 503 naming `web/dist` only when the build is absent.

## Next best step

`LAS-155` (the end-to-end acceptance gate) is next. `LAS-176` closed the
refactor: the completion gate re-ran the baseline and the import-direction
check on 2026-11-17 and found no behavior change. `LAS-153` and `LAS-154`
remain open in the tracker with acceptance tests outstanding, so the browser
pass, the cross-tab realtime path, and the palette still rely on manual
verification until those land.

## Tracker

- Linear workspace: last-known-good (`LAS`).
- Project: Curved (`P-LAS-8`).
- Spec issue: `LAS-140`, labelled `ready-for-agent`.
- Test seams agreed: service layer (primary), HTTP in-process fetch, raw SQL only
  for the append-only trigger and the partial unique index.
- Sub-issues (15, native `blockedBy` edges):
  - `LAS-141` foundation: toolchain, Postgres, migrations, project creation (done 2026-11-10)
  - `LAS-142` issue capture, atomic keys, append-only events (141) (done 2026-11-10)
  - `LAS-143` comments and timeline read path (142) (done 2026-11-10)
  - `LAS-144` status machine and actor matrix (142) (done 2026-11-10)
  - `LAS-145` agent identity and claim fence (144) (done 2026-11-10)
  - `LAS-146` block and unblock (145) (done 2026-11-10)
  - `LAS-147` MCP server over stdio (146) (done 2026-11-10)
  - `LAS-148` HTTP API and auth boundary (146) (done 2026-11-10)
  - `LAS-149` labels, relations, dependency-aware ready (148) (done 2026-11-10)
  - `LAS-150` SSE realtime stream (148) (done 2026-11-16)
  - `LAS-151` GitHub webhook and branch helper (148) (done 2026-11-16)
  - `LAS-152` SPA sign-in, setup, board (148, 149, 150) - prototyped, acceptance tests pending
  - `LAS-153` issue detail and human actions (152) - prototyped, acceptance tests pending
  - `LAS-154` command palette (153) - prototyped, acceptance tests pending
  - `LAS-155` end-to-end acceptance gate (147, 151, 153, 154)
- Refactor series (`LAS-167`): `LAS-168` architecture contract (done), `LAS-169`
  pure domain layer (done), `LAS-170` ports plus the projects resource (done
  2026-11-17), `LAS-171` issue lifecycle and read model on ports (done
  2026-11-17), `LAS-172` agents, claims, review, comments, and blocking on ports
  (done 2026-11-17), `LAS-173` labels, relations, and the GitHub use case on
  ports (done 2026-11-17), `LAS-174` the inbound-adapter rewire, composition
  roots, and the import-direction gate (done 2026-11-17), `LAS-175` the web
  layering (done 2026-11-17), and `LAS-176` the completion gate and handoff
  (done 2026-11-17). The parent `LAS-167` is complete.

## Session log

### Session 001

- Date: 2026-11-10
- Goal: install the repo agent harness.
- Completed: `AGENTS.md`, `MEMORY.md`, `scripts/init.sh`, `scripts/clean-state.sh`,
  `.gitignore` codegraph entry, codegraph index.
- Verification run: `./scripts/init.sh`, `./scripts/clean-state.sh`.
- Evidence captured: baseline green, gate green.
- Commits: none, repo is not under git.
- Known risk: baseline is trivially green until a real toolchain exists.
- Next best step: Node skeleton, then real install/check/build commands.

### Session 002

- Date: 2026-11-10
- Goal: turn the `curved-core` plan into a published spec.
- Completed: Linear project `Curved` (`P-LAS-8`) created in workspace
  last-known-good; spec issue `LAS-140` created in that project with label
  `ready-for-agent`, status Todo, priority High.
- Seams confirmed with the user: service layer primary, HTTP in-process fetch,
  raw SQL only for the append-only trigger and partial unique index.
- Verification run: `get_issue LAS-140` returns the full spec, label, and
  project id.
- Commits: none, repo is not under git.
- Known risk: the spec locks Node 26.2, MCP v2, and ports 4747/55432; the
  fallbacks are recorded in Further Notes.
- Next best step: execute `LAS-141`, starting with the Node skeleton.

### Session 003

- Date: 2026-11-10
- Goal: break `LAS-140` into publishable tickets.
- Completed: 15 sub-issues of `LAS-140` published (`LAS-141` to `LAS-155`) with
  label `ready-for-agent`, state Todo, project Curved, and native `blockedBy`
  edges; each carries What to build plus acceptance criteria.
- Sequencing decisions confirmed with the user: keep 15 slices, keep ready
  dependency-aware only from `LAS-149`, keep `LAS-155` as a separate gate.
- Verification run: `get_issue LAS-142/152/155` with `fields: ["relations"]`
  returns the expected `blocks` and `blockedBy` edges.
- Known risk: `LAS-145` ships ready before relations exist, so blocking
  relations do not exclude work until `LAS-149` lands. Agent tokens arrive in
  `LAS-145`; `LAS-144` proves agent and git actors at the service seam only.
- Next best step: execute `LAS-141` (foundation), then walk the frontier:
  `LAS-142`, then `LAS-143` and `LAS-144`, and so on.

### Session 004

- Date: 2026-11-10
- Goal: put the project under version control and publish it.
- Completed: `README.md` added; git repository initialized on `main`; initial
  commit `4b66958` ("Initial commit: project scaffold and working agreement");
  public GitHub repository created at `https://github.com/DietKyle956/Curved`
  and pushed.
- Verification run: `git ls-remote origin main` equals local HEAD; `gh repo view`
  reports visibility PUBLIC, default branch main; working tree clean and tracking
  `origin/main`.
- Known risk: none new. The baseline remains placeholder-green until `LAS-141`.
- Next best step: execute `LAS-141`.

### Session 005

- Date: 2026-11-10
- Goal: execute `LAS-141` (foundation: toolchain, Postgres, migrations, projects).
- Completed: Node 26.2/TypeScript project with strict server and web no-emit configs;
  `pg` module with `query`/`one`/`tx`; stable `ServiceError` codes with HTTP mapping;
  compose Postgres 18 on 55432 with readiness healthcheck; `scripts/db.sh`;
  advisory-locked migration runner with `schema_migrations`; `projects` schema;
  projects service plus `project add`/`project list` CLI; isolated `curved_test`
  harness; tests for keys, duplicates, ordering, transaction rollback, CLI end to
  end, and concurrent migration bootstrap; real install/database/check/build commands.
- Verification run: `npm run typecheck`; `npm test` (11 pass); `bash scripts/db.sh`;
  CLI add/list/duplicate/invalid against the development database; two concurrent
  migrations against a throwaway database; `./scripts/init.sh`; `./scripts/clean-state.sh`.
- Evidence captured: CLI printed `created project AAA (Alpha)`; list ordered `AAA`
  then `ZZZ`; duplicate exited 1 with `duplicate: ...`; the concurrency probe produced
  one ledger row and exactly one `applied 0001_projects`; schema inspected with psql.
- Coordination: four parallel slices, then a corrective pass after verification found
  the ledger-creation race before the advisory lock.
- Known risk: `build` is the typecheck gate for now; `START_CMD` is the CLI help until
  `LAS-148` ships the server.
- Next best step: execute `LAS-142`.

### Session 006

- Date: 2026-11-10
- Goal: execute `LAS-142` (issue capture, atomic keys, append-only events).
- Completed: `0002_issues.sql` (`issues` with unique `(project_id, number)` and the
  key format; `issue_events` with kind, actor, and status constraints plus a row
  trigger rejecting UPDATE and DELETE with SQLSTATE 23001); `src/shared/status.ts`
  contract; `services/issues` with one-statement number allocation, canonical key
  parsing, and a `created` event per issue in the same transaction;
  `services/events` append/list; `issue add`, `issue list`, `issue show` CLI commands
  with padded-key resolution; service, event, and CLI tests; README and AGENTS state.
- Verification run: `npm run typecheck`; `npm test` (30 pass); CLI smoke against the
  isolated test database (project `SMK`, 14 issues, `show SMK-014` resolved to
  `SMK-14`); `./scripts/init.sh`; `./scripts/clean-state.sh`.
- Evidence captured: contiguous keys `SMK-1` through `SMK-14`; padded JSON show
  returned `key: "SMK-14"` and `number: 14`; raw UPDATE and DELETE on `issue_events`
  rejected with `23001`; 25 concurrent creations produced `TAC-1` through `TAC-25`.
- Coordination: five parallel slices (schema/status, services, CLI, tests, docs).
  The migration test now derives expected versions from `migrations/*.sql` instead of
  pinning `0001_projects`.
- Known risk: `issues.claimed_by` is plain text until `LAS-145`; the partial unique
  fence and the transition rules land in `LAS-144` and `LAS-145`.
- Next best step: execute `LAS-143` and `LAS-144`.

### Session 007

- Date: 2026-11-10
- Goal: execute `LAS-143` (comments and the timeline read path).
- Completed: `services/comments` with `commentOnIssue` (trimmed body, empty body
  rejected as `validation`, actor defaulting to `human` and validated, issue resolved
  through `getIssue`, one `comment` event appended in a transaction); exported
  `validateActor`; `getIssueTimeline` returning the issue plus events ascending by
  id; `issue comment <KEY> <body...> [--actor <type>]`; `issue show` now renders the
  full timeline in human output and exposes `events` alongside the issue in `--json`;
  service, timeline, and CLI tests; README and AGENTS state.
- Verification run: `npm run typecheck`; `npm test` (41 pass); CLI smoke against a
  throwaway `curved_test_smoke` database (migrate, project, issue, human comment,
  agent comment on a padded key, empty and blank bodies, human and JSON show);
  raw UPDATE and DELETE on comment rows rejected with `23001`;
  `./scripts/init.sh`; `./scripts/clean-state.sh`.
- Evidence captured: timeline rendered `1 created human ... -`,
  `2 comment human ... first from human`, `3 comment agent ... second from agent`
  in ascending id order with no grouping by actor; `issue comment SMK-1 ""` exited 1
  with `validation: comment body must not be empty`; `--json` show returned
  `{ ...issue, events }`; psql UPDATE and DELETE both raised
  `issue_events is append-only` and the stored comments survived.
- Coordination: four parallel slices (services, CLI, tests, docs), then a corrective
  pass after the test slice asserted whitespace-padded key input that `parseIssueKey`
  never accepted (padded digits are accepted, surrounding spaces are not).
- Known risk: the event row still carries only `actor_type`, not an actor id; agent
  identity arrives in `LAS-145`. No comments table exists, by design.
- Next best step: execute `LAS-144`.

### Session 008

- Date: 2026-11-10
- Goal: execute `LAS-144` (status machine and actor matrix).
- Completed: `TRANSITIONS`, `ACTOR_TRANSITIONS`, `isLegalTransition`,
  `actorMayTransition`, and `allowedTransitions` in `src/shared/status.ts`;
  `moveIssue` locking the row by key with `SELECT ... FOR UPDATE` in one
  transaction, checking the legal edge then the actor gate, applying claim-column
  rules, writing exactly one `status` event with from/to, actor, and optional body,
  and returning the hydrated issue with `allowedTransitions`; `allowedTransitions`
  on every payload from `createIssue`, `getIssue`, `listIssues`, `getIssueTimeline`,
  and `moveIssue`; `issue move <KEY> <status> [--body <text>] [--actor <type>]
  [--agent <name>]` with `moved <KEY> to <status>` and `--json`; new
  `test/transitions.test.ts` with 12 tests and 5 appended CLI tests.
- Verification run: `npm run typecheck` green; `npm test` (58 pass, 0 fail); CLI
  smoke on a throwaway `curved_test_smoke144` database covering create, `todo`,
  `in_progress`, the JSON payload with `allowedTransitions`, illegal `done`,
  agent claim setting `claimed_by`, and agent `done` rejected; smoke database
  dropped; `./scripts/init.sh` green; `./scripts/clean-state.sh` all 7 checks pass
  with the expected uncommitted-tree warning.
- Evidence captured: `moved <KEY> to <status>` lines; the payload carried
  `allowedTransitions`; illegal `done` returned `illegal_transition`; agent `done`
  returned `forbidden_transition`; agent claim set `claimedBy`; smoke database
  dropped.
- Coordination: five parallel slices, no fix-up pass was needed.
- Known risk: the literal ticket matrix omits the claim edge, but the claim-column
  acceptance criterion requires it, so the agent edge is limited to unclaimed
  `todo -> in_progress` with a named agent. `claimed_by` is still plain text until
  `LAS-145`, and the partial unique claim fence does not exist yet.
- Next best step: execute `LAS-145`.
- Commits: 1 commit, `Add the status machine and actor matrix`.

### Session 009

- Date: 2026-11-10
- Goal: execute `LAS-145` (agent identity and the one-active-issue claim fence).
- Completed: `0003_agents.sql` (`agents` with unique trimmed name and SHA-256 token
  hash; pre-fence claim backfill and duplicate-claim demotion; `issues.claimed_by`
  FK; partial unique index `issues_one_active_claim_per_agent`;
  `review_submitted` event kind); `services/agents` with one-time `crv_` tokens and
  hash-only storage; `services/queue` with `listReady`, `claimNext`,
  `submitForReview`, and `releaseClaim`; advisory-lock serialization for same-agent
  claims and `skip locked` candidate selection; index-violation mapping to
  `agent_busy`; agent registration and claim-index mapping in `moveIssue`; comment
  ownership in `comments`; CLI `agent add`, `ready`, `claim`, `review`, `release`,
  and `issue comment --agent`; 22 service/queue tests plus CLI sequence tests;
  README and AGENTS state.
- Verification run: `npm run typecheck`; `npm test` (92 pass, 0 fail);
  `./scripts/init.sh`; CLI smoke on throwaway `curved_test_smoke145` covering
  migrate, project/issue create, `agent add`, ready (busy null), claim, agent_busy,
  ready busy key, review, agent_busy in review, human done, no_ready_issue, absent
  and invalid token failures, `ready --human`, and release; smoke database dropped;
  `./scripts/clean-state.sh`.
- Evidence captured: token length 36 with the `crv_` prefix; `claimed TAC-1` then
  `agent_busy: agent "alpha" already holds issue "TAC-1"`; review timeline
  `created, claim, review_submitted, status`; final `no_ready_issue`; 92 tests green.
- Coordination: three waves of parallel slices (schema/contracts, agents and
  issues/comments; queue and tests; CLI, CLI tests, docs), with one corrective pass
  for two test scenarios that skipped a legal edge.
- Known risk: blocking is still absent, so `ready` cannot yet exclude blocked
  relations; `LAS-146` adds block/unblock. The claim fence is global across
  projects, by design.
- Next best step: execute `LAS-146`.
- Commits: 1 commit, `Add agent identities and the one-active-issue claim fence`.

### Session 010

- Date: 2026-11-10
- Goal: execute `LAS-146` (block and unblock).
- Completed: `src/services/blocking.ts` with `blockIssue` (agent-owned
  `in_progress` only, trimmed 1..2000 character reason, status `todo`, cleared
  claim, stored `blocked_reason`, one `blocked` event) and `unblockIssue` (human
  only, non-null blocked reason required, clears it, one `unblocked` event,
  status/claim untouched); CLI `issue block <KEY> <reason...>` authenticated by
  `CURVED_AGENT_TOKEN`, `issue unblock <KEY> [--actor <type>] [--agent <name>]`,
  the fifth `issue list` column for the blocked reason, and usage text; new
  `test/blocking.test.ts` plus CLI blocking tests in `test/cli.test.ts`; README,
  AGENTS, and MEMORY state.
- Verification run: `npm run typecheck` green; `npm test` (102 pass, 0 fail); CLI
  smoke on throwaway `curved_test_smoke146` covering migrate, project/issue/agent
  create, claim, block (trimmed reason, Todo, cleared claim, blocked event), list
  fifth column, show reason, ready exclusion, unclaimable `no_ready_issue`,
  human unblock, ready reappearance, agent unblock rejected, missing token,
  block in `in_review` rejected, and blank reason rejected; smoke database dropped;
  `./scripts/init.sh`; `./scripts/clean-state.sh`.
- Evidence captured: `SMK-1\ttodo\t3\tBlock smoke target\twaiting on design`
  from `issue list`; timeline `created, claim, blocked, unblocked` in ascending
  order; blocked event body `waiting on design`, `in_progress -> todo`; ready
  printed only `busy: -` while blocked; `forbidden_transition` for agent unblock;
  `illegal_transition` for block in `in_review`; `validation` for blank reason.
- Coordination: five parallel slices (service, CLI, service tests, CLI tests,
  docs) in one wave; no fix-up pass was needed.
- Known risk: `unblockIssue` treats "not blocked" as `validation`, since the ticket
  does not pin a code for that case. Blocking uses the existing row lock and the
  existing `issues.blocked_reason` constraint, so no migration was required.
- Next best step: execute `LAS-147`.
- Commits: 1 commit, `Add agent block and human unblock`.

### Session 011

- Date: 2026-11-10
- Goal: execute `LAS-147` (MCP server over stdio).
- Completed: `@modelcontextprotocol/server` 2.4.0 and `zod` dependencies,
  `@modelcontextprotocol/client` as a dev dependency, and the `mcp` npm script;
  `src/mcp/tools.ts` (zod input schemas plus eight handlers thin over the service
  layer), `src/mcp/server.ts` (`createCurvedMcpServer`, `resolveAgentFromToken`,
  `serveStdio` lifecycle with stdin-end and signal shutdown), `src/mcp/main.ts`;
  `test/mcp.test.ts` with 13 stdio tests (raw JSON-RPC handshake, exact tool
  list, all eight tools, token failures, schema rejection, pretty JSON); README
  MCP section and AGENTS current state.
- Verification run: `npm run typecheck` green; `node --test test/mcp.test.ts`
  (13 pass); `npm test` (115 pass, 0 fail); real-entry smoke on throwaway
  `curved_test_smoke147` (initialize, `tools/list` exactly eight, `create_issue`
  `SMK-2 backlog`, `list_ready` `SMK-1`, `claim_next` with `created,claim`, second
  claim `agent_busy` naming `SMK-1`, `mark_blocked` `todo`/null claim/reason,
  ready empty, stderr empty); smoke database dropped; `./scripts/init.sh`;
  `./scripts/clean-state.sh`.
- Evidence captured: live tool names; pretty JSON payloads; zod failures return
  `Input validation error: Invalid arguments for tool ...` as `isError`; a blank
  token returns `not_authenticated` text naming `CURVED_AGENT_TOKEN`; stdout
  carried only JSON-RPC.
- Coordination: four parallel slices (implementation, tests, docs, npm script),
  then one corrective pass: the test expected a JSON-RPC InvalidParams rejection,
  but the v2 SDK catches schema failures and returns an `isError` result; helper
  and assertion corrected.
- Known risk: `create_issue` accepts no status, so it creates `backlog` issues;
  agents still need seeded `todo` work to claim. The HTTP server and UI remain
  `LAS-148`/`LAS-152`. Each stdio test spawns its own server process (~250ms).
- Next best step: execute `LAS-148`.
- Commits: 1 commit, `Add MCP server over stdio`.

### Session 012

- Date: 2026-11-10
- Goal: execute `LAS-148` (HTTP API and auth boundary).
- Completed: `src/http/app.ts` with `createApp` and every `/api` route,
  `src/http/auth.ts` (UI-token comparison, agent token resolution, SHA-256 session
  cookie), `src/http/spa.ts` (file lookup, index fallback, cache headers, 503 when
  the build is absent), and `src/server.ts` (PORT default 4747, required
  `CURVED_UI_TOKEN`, exit 1 when missing); the `start` npm script and `START_CMD`
  switched to `npm start`; `listIssues` gained `{ project?, status? }` filters;
  human-only `updateIssue` for title, description, and priority; `test/http.test.ts`
  with 15 in-process route tests and 6 issue tests for the filter and edit paths;
  README HTTP API section, AGENTS current state, and this memory entry.
- Verification run: `npm run typecheck` green; `npm test` (136 pass, 0 fail); a live
  smoke against a real `node src/server.ts` on a throwaway
  `curved_test_smoke148` database covering startup without the token, unauthenticated
  and wrong-token `401`, login cookie attributes, `/api/me` as human by cookie and
  by UI bearer, `/api/me` as agent from an `agent add --json` token, project create
  (agent `403`), issue create/list filters/show timeline, agent claim, second claim
  `409 agent_busy`, ready busy key, comment event, block to `todo` with cleared claim
  and reason, blocked issue absent from ready, agent unblock `403`, human unblock,
  re-claim, agent `in_review`, human `done`, human claim `403`, validation `400`,
  not_found `404`, duplicate `409`, non-JSON body `400`, unknown `/api` JSON `404`,
  no CORS headers on `GET`/`OPTIONS`, SPA `503` text naming `web/dist` and the build,
  and logout `204` clearing the cookie followed by `401`; smoke database dropped.
- Evidence captured: `curved_session=<sha256>; HttpOnly; SameSite=Lax; Path=/;
  Max-Age=2592000`; `401 not_authenticated` for a missing bearer; `403
  forbidden_transition` for human-only routes as an agent and for agent unblock;
  `409 agent_busy` on the second claim; `201` with `{ issue, events }` on the
  timeline; the `503` body naming `web/dist` and the build command; exit 1 with
  `CURVED_UI_TOKEN is required to start the HTTP server`.
- Coordination: three parallel slices (HTTP app and auth, server entry and SPA, HTTP
  tests), then one inline fix: `server.ts` called the synchronous `toRequest` as if
  it returned a promise.
- Known risk: the SPA still answers 503 until `LAS-152` builds `web/dist`; issue
  field edits append no timeline event because no event kind exists; agent-created
  HTTP issues record the actor `agent` without an identity because `createIssue` has
  no agent parameter.
- Next best step: execute `LAS-149`.
- Commits: 1 commit, `Add the HTTP API and auth boundary`.

### Session 013

- Date: 2026-11-10
- Goal: execute `LAS-149` (labels, relations, dependency-aware ready).
- Completed: `0004_labels_relations.sql` (`labels` unique per project with a
  trimmed 1..50 name, `issue_labels` link table, `issue_relations` directed edges
  with a no-self check and a `blocked_issue_id` index); `src/services/issue-meta.ts`
  with `emptyMeta` and the two-query batch `loadIssueMeta`; `Issue` gains
  `labels` and `relations: { blocks, blockedBy }` on every hydration path;
  `listIssues` is three statements for a non-empty project list with an
  empty-result existence check preserving `not_found`; `listReady` and `claimNext`
  exclude issues with an unfinished blocker; `setIssueLabels` and `addRelation`
  services with JSON-bodied `labels` and `relation` events; human-only
  `POST /api/issues/:key/labels` and `POST /api/issues/:key/relations`; `issue show`
  renders `labels`, `blocks`, and `blocked_by`; `test/labels.test.ts` (9 tests,
  including the three-statement query budget) and `test/relations.test.ts` (5
  tests, including cross-project gating); HTTP route and ready tests in
  `test/http.test.ts`; README, AGENTS, and this memory entry.
- Verification run: `npm run typecheck` green; `npm test` (154 pass, 0 fail); a live
  smoke against a real `node src/server.ts` on a throwaway
  `curved_test_smoke149` database covering label replace/dedupe/trim, relation add
  and duplicate ignore, both payload directions, agent `403 forbidden_transition`
  on both routes, `400 validation` for a self relation, `404 not_found` for an
  unknown blocking key, ready excluding the blocked issue and including it after
  the blocker reached `done`, claim of the unblocked issue, timeline JSON bodies,
  the three-statement project list path, and CLI `issue show` rendering labels,
  blocks, and blocked_by; smoke database dropped and server stopped.
- Evidence captured: `{"labels":["bug","ui"]}` and
  `{"blocking":"SMK-2","blocked":"SMK-1"}` event bodies; `ready:["SMK-2"]` then
  `ready:["SMK-1"]`; `403 {"code":"forbidden_transition","message":"this action is
  restricted to humans"}`; CLI lines `labels: bug, ui`, `blocks: -`,
  `blocked_by: SMK-2`; duplicate relation produced one event.
- Coordination: eight parallel slices (core schema/metadata/queue, labels service,
  relations service, HTTP routes, CLI render plus its exact-output tests, service
  tests, HTTP tests, docs), all green without a fix-up pass.
- Known risk: relation cycles are permitted and keep the affected issues out of
  `ready`; labels cannot be renamed or deleted independently of a set replacement;
  relation writes are HTTP-only (no CLI or MCP verb), by design.
- Next best step: execute `LAS-150` and `LAS-151`.
- Commits: 1 commit, `Add labels, relations, and dependency-aware ready`.

### Session 014

- Date: 2026-11-16
- Goal: prototype the Curved web client on the supplied warm dark palette.
- Completed: Vite 8 + React 19 + Tailwind v4 SPA in `web/` with Motion and
  Phosphor; `npm run build` now typechecks both trees and writes `web/dist`;
  `npm run dev` proxies `/api`. Screens: UI-token sign-in, first-run project
  setup, desktop five-lane board with drag transitions, mobile status list, ready
  queue with claim order, in-flight agents and human unblock, issue detail with
  timeline, comments, title/description/priority edits, label replacement,
  blocking relations and unblock, `Ctrl/Cmd+K` palette, new issue dialog, toasts,
  skeletons, empty states, and inline error handling. Design system: fixed warm
  near-black palette, Instrument Sans + JetBrains Mono, 5 px radius, spice as the
  only primary accent with semantic status accents, fixed dark theme. The app
  shell is viewport-fixed with independent scroll regions; the inspector overlays
  on `lg`, is static on `xl`, and is full-screen below `lg`. No em dashes.
- Verification run: `npm run typecheck` green; `npm run build:web` green;
  `npm test` not changed (154 tests, run in the final baseline). Live Chromium pass
  against `node src/server.ts` on 4747 with a local demo project and agents at
  1440, 1024, and 390 px: sign-in and mobile fold, first-run project creation and
  empty board, new issue with labels, comment append, status transition and undo,
  label save, relation add, drag from Backlog to Todo and back, queue unblock and
  restore, palette search and Enter-to-open, browser Back closing the inspector,
  offline refresh banner and recovery, empty filtered board, and no console
  errors. A computed WCAG pass over board and detail text returned no failures.
  The demo project (`CRV`, 26 issues, 5 agents) lives only in the local dev
  database; the `curved_test` database was untouched.
- Evidence captured: `Created CRV-26` toast and navigation to
  `/p/CRV/i/CRV-26`; `Moved CRV-1 to Todo` after drag; `Unblocked CRV-10` and the
  queue returning from 6 ready/1 blocked to 7/0; `CRV-25 now blocks CRV-26` in the
  timeline; `Refresh failed: Could not reach the server` with the network off and
  its disappearance after refresh; no horizontal page scroll at 1024 after fixing
  the shell.
- Known risk: no automated frontend tests; verification is a browser pass. The
  production bundle is 519 kB minified (155 kB gzip) and Vite warns above 500 kB.
  Real iOS safe-area and software-keyboard behavior were not exercised; the
  composer uses `env(safe-area-inset-bottom)` and a fixed shell. SSE is not wired,
  so the client polls every 20 seconds while visible.
- Next best step: `LAS-150` SSE, then replace the poll with a stream and close the
  remaining SPA tickets.
- Commits: 1 commit, `Prototype the web client`.

### Session 015

- Date: 2026-11-16
- Goal: open issue cards in a centered container instead of a side panel.
- Completed: new shared `web/src/components/Modal.tsx` (backdrop, Escape and
  backdrop close, body scroll lock, panel focus on open with restore on close,
  Tab trap) now used by both `Dialog` and `IssueDetail`; `Dialog` keeps its title
  header and sizes; the issue detail is a 768 px centered panel capped at
  `min(100dvh - 3rem, 50rem)` with a 5 px radius, border, and `shadow-float` from
  `sm` up, and stays a borderless full-screen sheet below `sm`. Removed the
  sidebar breakpoints and the redundant back arrow; the close button is now
  visible at every width. The detail body resets to the top when the open issue
  changes, and the panel widens its padding from `sm`.
- Verification run: `npm run typecheck` green; `npm run build` green;
  `./scripts/init.sh --no-install` green; `npm test` green (154 pass, 0 fail); a
  live Chromium pass against `node src/server.ts` on 4747 with the local `CRV`
  demo project. At 1440x900 the panel measured 768x800 at x=336, y=50 (centered),
  with the footer composer inside the panel; at 1024x768 it measured 768x720 at
  x=128, y=24; at 390x844 it measured the full 390x844 with 0 radius and the
  composer at the viewport bottom. Escape and a backdrop click both closed it and
  returned to `/p/CRV`; palette Escape closed the palette first and left the issue
  modal open; a second Escape closed the modal; browser Back moved CRV-5 back to
  CRV-3, then to the board; comment append worked from the modal footer; the
  panel took focus on open, 40 Tab presses and Shift+Tab from the panel stayed
  inside, focus returned to the opening card on close; a comment draft survived a
  refresh; the new issue dialog still centers at 512 px and its title input keeps
  autofocus.
- Evidence captured: centered rect values above; `aria-modal="true"`,
  `aria-label="Issue CRV-3"`, `role="dialog"`; palette-then-modal Escape ordering
  `{palette:false, modal:true}` then `{palette:false, modal:false}`; focus trap
  `true`; comment `Modal redesign check` appended and the composer cleared.
- Known risk: no frontend test framework, so the modal layout is covered by the
  browser pass only; the issue modal remains route-driven and unmounts on close,
  so its exit animation still does not play.
- Next best step: `LAS-150` SSE, then replace the poll with a stream and close the
  remaining SPA tickets.
- Commits: 1 commit, `Open issue detail as a centered modal`.

### Session 016

- Date: 2026-11-16
- Goal: execute `LAS-150` (SSE realtime stream).
- Completed: migration `0005_issue_notifications.sql` with `notify_issue_change()`
  firing `after insert` and `after update` on `issues` and `after insert` on
  `issue_events`, calling `pg_notify('issues_changed', project_id::text)` for the
  owning project; `src/http/event-hub.ts` with one lazily opened shared `pg.Client`
  per app running `LISTEN issues_changed`, numeric project-id fan-out, a single
  1s reconnect while subscribers remain, and `stats()`/`close()`; `src/http/sse.ts`
  serving `GET /api/events` as `text/event-stream` with `ready`, `issues_changed`
  (project id as `data`), and a 25 second `ping`; cookie-only session resolution for
  the stream, which ignores `Authorization` so a bearer-only request is `401`;
  `createApp` now requires `databaseUrl` and owns the hub when none is injected,
  with `close()` shutting the owned hub down; `src/server.ts` streams event-stream
  responses chunked with backpressure, gives each request an `AbortSignal` aborted
  on client disconnect, and closes the app, hub, and connections on shutdown; the
  web client's 20 second poll replaced by one `EventSource` in
  `web/src/lib/events.ts` (project filter, board and open detail refresh, 1s
  reconnect guard); new `test/event-hub.test.ts` and `test/sse.test.ts`, with
  `test/http.test.ts` updated for `databaseUrl`/`close`; README, AGENTS, and this
  memory entry.
- Verification run: `npm run typecheck` green; targeted
  `node --test --test-concurrency=1 test/event-hub.test.ts test/sse.test.ts
  test/http.test.ts` 28 pass; `npm test` 164 pass, 0 fail; `npm run build` green;
  live smoke against a real `node src/server.ts` on 4750 with a throwaway
  `curved_test_smoke150` database. No-cookie and bearer-only `/api/events` both
  returned `401` JSON; the cookie stream returned the SSE headers above with
  `ready` as the first frame. A CLI `issue add` produced `issues_changed` with
  `data: 1` 3 ms after the CLI exited; a `ping` arrived inside the 25 second
  window; aborting curl left `/api/me` at 200; Postgres showed exactly one
  `LISTEN` backend. A real Chromium board at 1440x900 showed the new card 109 ms
  after the CLI created it and a CLI comment in the open detail 106 ms after it was
  written, with one `/api/events` request and no page errors. Smoke database
  dropped and server stopped.
- Evidence captured: `text/event-stream; charset=utf-8`, `cache-control: no-cache,
  no-transform`, and `x-accel-buffering: no`; `event: ready` before any change;
  `event: issues_changed` / `data: 1` after the CLI write; the 25 second `ping`;
  `401 not_authenticated` for no cookie and for bearer-only; one `LISTEN` row in
  `pg_stat_activity`; Chromium timings of 109 ms for the board and 106 ms for the
  open detail.
- Known risk: browser coverage is a manual Chromium pass with no frontend test
  framework; the hub keeps its single LISTEN client open after the last subscriber
  until app shutdown; `updateIssue` still appends no timeline event, but its row
  update fires the `issues` update trigger, so the board still refreshes.
- Next best step: execute `LAS-151`, then close `LAS-152`/`LAS-153`/`LAS-154` once
  their acceptance tests land.
- Commits: 1 commit, `Add the SSE realtime stream` (`74be39b`).

### Session 017

- Date: 2026-11-16
- Goal: execute `LAS-151` (GitHub webhook and branch helper).
- Completed: `src/services/github.ts` with `issueKeyFromText` (first
  `ABC-123` match, unpadded), `branchNameForIssue` (canonical key plus a 60
  character title slug), and `applyPullRequestEvent` (event header filter,
  top-level `action` with nested fallback, `opened`/`reopened` to `in_review`,
  closed and merged to `done`, key from `head.ref` then title, `git` actor via
  `moveIssue`, ignored-error mapping); `src/http/webhook.ts` with `githubSignature`
  and `handleGithubWebhook` (raw body first, constant-time `sha256=` compare,
  `webhook_not_configured` when `GITHUB_WEBHOOK_SECRET` is blank, `401` on
  mismatch, `validation` on non-JSON, `{"ok":true}` / `{"ok":true,"ignored":true}`);
  `CreateAppOptions.webhookSecret` and the `/webhooks/github` route placed before
  the `/api` branch; `server.ts` passing `config.webhookSecret`; CLI
  `git-branch <KEY> [--json]`; new `test/github.test.ts` and four `git-branch`
  cases in `test/cli.test.ts`; README webhook section and AGENTS current state.
- Verification run: `npm run typecheck` green; targeted
  `node --test --test-concurrency=1 test/github.test.ts test/cli.test.ts` 55 pass;
  `npm test` 187 pass, 0 fail; `npm run build` green; live smoke against a real
  `node src/server.ts` with throwaway `curved_test_smoke151` on ports 4751 (no
  secret) and 4752 (secret). Unconfigured server answered 503
  `webhook_not_configured`; wrong and missing `x-hub-signature-256` answered 401
  with the issue untouched; a valid HMAC with no cookie and no bearer moved
  `SMK-1` `in_progress -> in_review` with a `status` event by `git`, body
  `pull request #7 opened`; the replay was `{"ok":true,"ignored":true}` with no
  new event; closed-unmerged was ignored; closed-merged moved `in_review -> done`;
  a non-PR event and an unknown key were ignored; `head.ref` beat a conflicting
  title; a valid HMAC with a bogus bearer still succeeded; `/api/issues` without
  credentials stayed 401; `git-branch SMK-002` printed `SMK-2-other-target`;
  smoke database dropped and server stopped.
- Evidence captured: `503 {"error":{"code":"webhook_not_configured",...}}`;
  `401 {"error":{"code":"not_authenticated","message":"webhook signature
  mismatch"}}`; `{"ok":true}` and `{"ok":true,"ignored":true}` responses; the
  timeline `status git in_progress>in_review "pull request #7 opened"` and
  `status git in_review>done "pull request #7 closed"`; `git-branch` plain, padded,
  `--json`, and `not_found` exit 1 outputs.
- Coordination: five parallel slices (service helper, webhook route and wiring,
  CLI, tests, docs), then one corrective pass after the docs slice flagged that
  real GitHub deliveries put `action` and `number` at the payload top level.
- Known risk: keys are uppercase, so a lowercase branch such as
  `tac-14-fix` falls through to the pull request title; closed-unmerged is ignored
  by design; the webhook has no delivery-id dedupe because a replay is already an
  illegal transition.
- Next best step: close `LAS-152`/`LAS-153`/`LAS-154` once their acceptance tests
  land, then `LAS-155`.
- Commits: 1 commit, `Add the GitHub webhook and branch helper`.

### Session 018

- Date: 2026-11-16
- Goal: close `LAS-152` (SPA foundation: sign-in, setup, and board).
- Completed: `web/src/lib/router.ts` gains a `new` route (`/new`, `/p/<KEY>/new`),
  `newIssuePath`, an exported `NAVIGATE_EVENT = "navigate"`, and a
  `NavigateEventDetail { path, replace }` dispatched from `navigate()` and from the
  `popstate` handler; `app.tsx` makes the new-issue dialog route-driven (direct
  loads, Back, and the post-create redirect to the issue path all agree, with a
  `parseRoute` guard so the create redirect is not clobbered on close) and keeps the
  column-seeded default status in app state. `Board.tsx` replaces the top in-flow
  mobile status strip with a fixed five-status bar above the shell's `MobileNav`
  (`bottom-[calc(3.5625rem+env(safe-area-inset-bottom))]`, z-20, blurred, 5-column
  grid, 44 px cells, per-status counts, tap-active-again to return to all issues)
  and keeps the card list clear of both bars (`pb-[calc(7.5rem+env(...))]`).
  `styles.css` overrides `--breakpoint-lg: 900px`, so five horizontally scrollable
  columns appear at 900 px and the mobile list below it. `PriorityMark` in
  `ui.tsx` now renders the priority as a colored dot (`bg-current` under the
  existing priority tone) with the label kept in the title and `sr-only` text.
- Acceptance matrix: AC1 passed (Vite build served by `src/server.ts`); AC2 passed
  (routes plus `navigate` event); AC3 passed (cookie session, reload, wrong token
  message); AC4 passed (empty install shows setup and creates a project); AC5
  passed (390x844 bottom bar, 5 statuses, 44 px, counts, card list); AC6 passed
  (900 px → five columns, 899 px → list); AC7 passed (key, title, priority dot,
  label chips, blocked badge, claimer initials); AC8 passed (SSE refetch); AC9
  partial by decision: CSS custom properties and safe-area insets hold, but the
  theme stays locked dark, the fonts stay self-hosted `@fontsource`, and spacing
  stays on Tailwind's 4 px scale, because `AGENTS.md` fixes the warm near-black
  palette; AC10 passed (one `GET /api/issues?project=` per project, counts derived
  client-side, no per-status requests).
- Verification run: `npm run build` green (typecheck of server and web plus Vite);
  `npm test` 187 pass, 0 fail; `./scripts/init.sh --no-install` green;
  `./scripts/clean-state.sh` green. Live Chromium pass against `node src/server.ts`
  on 4747 with the local `CRV` demo project, plus a throwaway
  `curved_test_las152` database on 4753 for the empty install. Mobile 390x844:
  status bar `fixed`, 44 px per cell, counts 9/9/2/2/6, zero overlap with the
  primary nav, last card reachable at full scroll, no horizontal page scroll.
  Desktop 900x700: five visible columns, scroller 1304 px wide in a 664 px
  viewport (horizontal scroll), counts 7/9/2/2/6, sidebar visible, mobile bars
  hidden; 899 px showed the mobile list only. Routes: direct `/p/CRV/new` opened
  the dialog; Escape replaced to `/p/CRV`; Primary-nav New pushed `/p/CRV/new`
  with event `{replace:false}`; cancel replaced to `/p/CRV` with `{replace:true}`;
  Back fired a `popstate` navigate event; creating through the dialog moved to
  `/p/CRV/i/CRV-28`; bare `/new` opened the dialog against the default project.
  Sign-in: wrong token showed `token is not valid`, the correct token set the
  cookie, and a reload stayed signed in. Empty install: setup screen, project
  `AB` created, board empty. Cross-tab SSE: a CLI `issue add` appeared on a second
  tab 57 ms later (limit one second). Board load made exactly one
  `GET /api/issues?project=CRV` (plus `/api/ready`, `/api/me`, `/api/projects`,
  `/api/events`).
- Evidence captured: bar rects `{statusBar: 0..390 x 742..787, primaryNav: 787..844}`
  with `overlapPx: 0`; cells `h:44 w:78` with counts; `overflowX: auto`,
  `scrollWidth 1304 / clientWidth 664`; navigate event details above; `57 ms` SSE
  delta; `apiReqs` list with a single issues request.
- Known risk: no frontend test framework, so this stays a browser pass; AC9's
  light-mode, system-font, and 8 px-scale clause is intentionally unmet and is
  recorded on the ticket; the demo `CRV` project now holds `CRV-27` and `CRV-28`
  from this pass.
- Next best step: `LAS-153` (issue detail and human actions).
- Commits: 1 commit, `Route the SPA and finish the mobile board`.

### Session 019

- Date: 2026-11-17
- Goal: close `LAS-168` (architecture contract and `ARCH.md` template), under
  `LAS-167` (Hexagonal Refactor). Documentation only.
- Completed: `ARCH.md` (550 lines) with a two-tense Current/Target convention and
  nine sections: the layer map and one-way dependency rule (target `src/` and
  `web/src/` trees, the sanctioned `http -> github, sse, static` peer set, the
  composition-root rule); the rule-ownership table (one owner per rule plus its
  current home, the five duplicate key regexes to delete, and bounded mirrors such
  as the Postgres CHECK constraints and web imports of `src/shared/status.ts`); the
  current state with the six-step expand-contract migration table and the no-shim
  rule; ports (one `ports.ts`, `TransactionPorts`, `Ports.transaction`,
  `ActiveClaimConflict`), the canonical lock/check/write/append-event/reload
  sequence for the six status and claim use cases, and the preserved SQL invariants
  (counter CTE, lock by key, `for update skip locked`, advisory lock 727275 against
  migrations' 727274, the two-statement meta batch, the three-statement listing
  budget, append trigger SQLSTATE 23001, `pg_notify` triggers); error translation
  (one per crossing, 23505 to `duplicate`, partial index to `ActiveClaimConflict`
  then `agent_busy`, HTTP status mapping only in the HTTP adapter) with the
  code-to-HTTP table; web layering (`main.tsx` as the only importer of both `ui`
  and `application`, the current `SignIn.tsx`/`ProjectSetup.tsx` violations and the
  786-line `app.tsx`, the reference client marked machine-local and illustrative);
  testing policy (the 187 tests in 16 files as the regression contract, six seams,
  no new implementation-detail tests, no web test framework); the nine-item review
  checklist; and enforcement (`npm run check`, the planned import-direction check,
  the forbidden-directions table, review-only until migration step 6). `AGENTS.md`
  gained an `ARCH.md` directory-page entry and one current-state sentence.
  `/home/dietkyle/projects/templates/ARCH.md` (111 lines) is the project-agnostic
  minimum contract, `templates/index.md` lists it as copy-first item 2, and
  `templates/AGENTS.md` now reads it in startup step 2 and lists it under required
  artifacts. `LAS-177` was filed for a full template audit.
- Verification run: `npm run check` green (server and web typecheck plus 187
  tests, 0 fail); `./scripts/init.sh --no-install` green (61s: install, database,
  check, build); `./scripts/clean-state.sh` green. `git status` shows only
  `ARCH.md` (new), `AGENTS.md`, and `MEMORY.md`, so no source, test, migration, or
  `package.json` change.
- Evidence captured: nine sections and the two-tense convention in `ARCH.md`; the
  rule-ownership table with its five duplicate regexes; the six-step migration
  table; the preserved lock numbers and SQLSTATE 23001; the 111-line template and
  its `index.md` slot.
- Known risk: `ARCH.md` describes a target tree that does not exist yet, so readers
  must honor its Current/Target markers; the import-direction check is planned and
  absent, so layering stays review-only until migration step 6; the web has no
  automated test coverage. The template startup gap is closed: `templates/AGENTS.md`
  reads `ARCH.md` in step 2 and lists it under required artifacts; `LAS-177` covers
  the wider template audit.
- Next best step: `LAS-169` (extract the pure domain layer).
- Commits: 2 commits, `Codify the architecture contract` and
  `Record the template ARCH startup step`.

### Session 020

- Date: 2026-11-17
- Goal: execute `LAS-169` (extract the pure domain layer), step 2 of the
  `LAS-167` refactor. No observable behavior change.
- Completed: `src/domain/` with `status.ts` (contract and guards), `transition.ts`
  (`TRANSITIONS`, `LEGAL_EDGES`, `isLegalTransition`), `actors.ts`
  (`ACTOR_TRANSITIONS` with `human` derived from `LEGAL_EDGES`, `actorMayTransition`,
  `TransitionContext`, `allowedTransitions`, `resolveContext`, `validateActor`),
  `claim.ts` (`nextClaimedBy`), `move-policy.ts` (`mayMove`), `keys.ts` (both key
  patterns, `ISSUE_KEY_IN_TEXT`, `parseIssueKey`, `issueKeyFromText`,
  `branchNameForIssue`), `validation.ts` (every field validator and max-length
  constant including label normalization, block reason, comment body, and review
  summary), `errors.ts` (`ERROR_CODES`, `ServiceError`), and `types.ts` (`Issue`,
  `Project`, `Agent`, `CreatedAgent`, `IssueEvent`, `IssueMeta`, `IssueRelations`,
  `emptyMeta`). `src/http/errors.ts` took `HTTP_STATUS`, `httpStatusFor`,
  `errorBody`, and `ErrorBody` out of the domain. `src/shared/status.ts` and
  `src/errors.ts` were deleted. Services, `src/mcp/*`, `src/http/auth.ts`,
  `src/http/webhook.ts`, `src/cli.ts`, `src/migrate.ts`, `web/src/lib/{types,
  presentation}.ts`, and every affected test import now point at the domain; the
  duplicate key regexes in the MCP zod schemas, `issues.ts`, `projects.ts`, and
  `github.ts` are gone. `ARCH.md` records step 2 and the acyclic ownership split;
  `AGENTS.md` records the layer and moves the frontier to `LAS-170`.
- Verification run: `npm run typecheck` green before and after deleting the old
  modules; `npm test` 187 pass, 0 fail; `./scripts/init.sh --no-install` green
  (database, check, build, codegraph sync: 10 added, 31 modified, 2 removed);
  live HTTP smoke on a throwaway `curved_smoke169` database (migrate, server on
  4757, `/api/me`, create project `SMK`, create issue `SMK-1` as `backlog` with
  `allowedTransitions ["todo"]`, move to `todo` with `["backlog","in_progress"]`,
  illegal `todo -> done` answered 409 `issue "SMK-1" cannot move from "todo" to
  "done"`, timeline `created:human,status:human`), then the database dropped.
- Evidence captured: the smoke payloads above; `grep` over `src/domain/**` shows
  domain-only imports and no `pg`, `node:*`, `react`, `fetch`, or `process.env`;
  `git diff src/services` contains no SQL line changes; `git diff test/` contains
  import lines only; 455 lines deleted against 119 added outside the new domain
  modules.
- Coordination: two dispatch waves with subagents - four disjoint foundation
  slices, then five disjoint consumer rewires, then one corrective import fix -
  with typecheck and the full suite run by the orchestrator between waves.
- Known risk: the MCP issue-key zod schema keeps its message as a pinned literal
  (`^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$`) because the domain pattern carries capture
  groups and `parseIssueKey` already pins the grouped form; validation still uses
  the domain regex, and the comment in `src/mcp/tools.ts` says so. The
  import-direction check and steps 3 to 6 remain, so layering is still review-only.
- Next best step: `LAS-170` (ports and the Postgres repositories).
- Commits: 1 commit, `Extract the pure domain layer`.

### Session 021

- Date: 2026-11-17
- Goal: execute `LAS-170` (introduce ports and migrate the projects resource),
  step 3's first slice of the `LAS-167` refactor. No observable behavior change.
- Completed: `src/application/ports.ts` with `ProjectRepository` (`create`,
  `list`, `findByKey`), `TokenCodec` (`mint`, `hash`), `ActiveClaimConflict`,
  `TransactionPorts` (`projects`, `tokens`), and `Ports` (`transaction(fn)`), none
  of them carrying pg types or a nested transaction member;
  `src/application/projects.ts` with SQL-free `createProject`/`listProjects`;
  `src/adapters/postgres/repositories/projects.ts` (the three preserved project
  statements, key-ordered list, `findByKey`, `23505` to `duplicate` with the
  identical message); `src/adapters/postgres/ports.ts` (`createPorts` binding the
  repository and codec to the pool or `Database.tx`); and
  `src/adapters/token-codec.ts` (`createTokenCodec`) now backing
  `src/services/agents.ts`. `src/services/projects.ts` is deleted.
  `createApp` requires `ports: Ports`; `src/server.ts` and both CLI project
  branches build it. `test/helpers/db.ts` exposes `TestDatabase.ports`.
- Verification run: `npm run typecheck` green; the project-path suites
  (`projects`, `agents`, `http`, `cli`, `mcp`, `github`, `sse`) 122 pass, 0 fail;
  full `npm test` 189 pass, 0 fail; live smoke on a throwaway `curved_smoke170`
  database (migrate; CLI `project add SMK`, duplicate `1 duplicate: project key
  "SMK" already exists`, list `SMK\tSmoke Project`, invalid key `1 validation:
  project key "bad" must match ^[A-Z][A-Z0-9]{1,9}$`; server on 4758: `POST
  /api/projects` 201 with the full project payload, duplicate 409, invalid key
  400, list ordered `API` then `SMK`, bearer-only mismatch 401
  `not_authenticated`), then the database dropped.
- Evidence captured: the smoke payloads above; `grep` over `src/application/`
  finds no `pg`, `src/db.ts`, SQL keyword, or `node:*`; no file still imports
  `services/projects.ts` or the deleted token helpers.
- Coordination: five parallel subagents (ports core, Postgres adapter, inbound
  wiring, core tests, test sweep), then two documentation subagents, with the
  orchestrator running typecheck, the targeted suites, the full suite, and the
  live smoke between waves.
- Known risk: `Ports` intentionally wires only the migrated resource plus the
  token codec; `IssueRepository`, `AgentRepository`, `EventRepository`,
  `IssueMetaRepository`, `LabelRepository`, and `RelationRepository` arrive with
  `LAS-171` to `LAS-173`, so `ARCH.md` section 4's full inventory is still
  target-only. The import-direction check remains planned, so layering stays
  review-only; `ActiveClaimConflict` is declared but no adapter throws it until
  the claim migration.
- Next best step: `LAS-171` (issue lifecycle and read model on ports).
- Commit: `Introduce ports and migrate the projects resource`.

### Session 022

- Date: 2026-11-17
- Goal: execute `LAS-171` (issue lifecycle and read model on ports), step 3's
  second slice of the `LAS-167` refactor. No observable behavior change.
- Completed: `src/application/issues.ts` with `createIssue`, `listIssues`,
  `getIssue`, `getIssueTimeline`, `updateIssue`, and `moveIssue`;
  `src/application/issue-read-model.ts` with `toIssue` (derives
  `allowedTransitions`) and `hydrateIssue`; `IssueRecord`, `LockedIssueRecord`,
  `IssueRepository`, `IssueEventRepository`, `IssueMetaRepository`, and
  `AgentRepository` in `src/application/ports.ts`, with `TransactionPorts`
  carrying projects/issues/events/meta/agents/tokens; adapters
  `src/adapters/postgres/repositories/issues.ts`, `issue-events.ts`,
  `issue-meta.ts`, and `agents.ts`, plus `bindPorts(db)` exported from
  `src/adapters/postgres/ports.ts` with `createPorts` delegating to it.
  `src/services/issues.ts`, `events.ts`, and `issue-meta.ts` are deleted; `queue`,
  `blocking`, `comments`, `labels`, `relations`, and `github` are rewired through
  `bindPorts` and the application modules, and HTTP, the webhook, the CLI, and
  MCP (`ToolDeps.ports`) pass `ports`. A partial-index violation on
  `updateStatus` now surfaces as `ActiveClaimConflict`, mapped by `moveIssue` and
  `claimNext` to the unchanged `agent_busy` message.
- Verification run: `npm run typecheck` green; full `npm test` 189 pass, 0 fail;
  HTTP create/list/PATCH/transition/timeline and CLI show/list/add/move exercised
  against a live server.
- Evidence captured: tests changed imports and wiring only; SQL text, invariants,
  error codes and messages, and payloads are unchanged; `listIssues` remains
  three statements.
- Known risk: `queue.ts` still owns the advisory lock, the skip-locked candidate
  select, and the claim SQL, `blocking.ts` still owns its raw status and reason
  updates, and `labels`/`relations` still own their table SQL until `LAS-172` and
  `LAS-173`, so `ARCH.md` section 4's full inventory stays target-only and
  layering remains review-only until the import-direction check lands.
- Next best step: `LAS-172` (agents, claims, review, comments, and blocking on
  ports).

### Session 023

- Date: 2026-11-17
- Goal: execute `LAS-172` (agents, claims, review, comments, and blocking on
  ports), step 3's third slice of the `LAS-167` refactor. No observable behavior
  change.
- Completed: `src/application/agents.ts` with `createAgent`,
  `authenticateAgent`, and `ensureAgentExists`, token mint and hash behind
  `TokenCodec`; `src/application/queue.ts` with `ReadyQueue`, `listReady`,
  `claimNext`, `submitForReview`, and `releaseClaim`;
  `src/application/blocking.ts` with `blockIssue` and `unblockIssue`;
  `src/application/comments.ts` with `commentOnIssue`. `AgentRepository` is now
  `create({ name, tokenHash })`, `findByTokenHash`, `findByName`, and
  `acquireClaimLock`, and `IssueRepository` adds `block`, `unblock`, and
  `lockClaimCandidate`. `src/adapters/postgres/repositories/agents.ts` owns the
  advisory lock `pg_advisory_xact_lock(727275, hashtext($1))` and the `23505`
  duplicate translation; `src/adapters/postgres/repositories/issues.ts` owns the
  skip-locked candidate query and the single-statement block and unblock updates.
  `src/services/agents.ts`, `queue.ts`, `blocking.ts`, and `comments.ts` are
  deleted, leaving `github.ts`, `labels.ts`, and `relations.ts`. Wiring: HTTP
  `resolveActor` takes `{ ports, uiToken }` and the comment, block, unblock,
  release, ready, and claim routes receive `ports`, with `db` kept only for
  labels, relations, and the event hub; the CLI builds `createPorts(db)` per
  `withDatabase` scope and uses `withAgent(ports, config, fn)`; MCP `ToolDeps` is
  `{ ports, resolveAgent }` with `resolveAgentFromToken(ports, config)` and no
  `db` field.
- Verification run: `npm run typecheck` green; full `npm test` 189 pass, 0 fail;
  live CLI project list, issue list, and ready, plus a live HTTP server check of
  `/api/me`, `/api/ready`, an unauthenticated 401, and an invalid agent bearer
  401; `scripts/init.sh` and `scripts/clean-state.sh` green.
- Evidence captured: tests changed imports and the first argument only; no
  assertion was weakened; the SQL invariants (advisory lock scope, skip-locked
  candidate ordering, single-statement block and unblock) are preserved.
- Known risk: labels, relations, and the GitHub SQL remain in `src/services/`
  until `LAS-173`; the event hub is still constructed in `createApp`; the
  import-direction check is still planned, so layering stays review-only.
- Next best step: `LAS-173` (labels, relations, and the GitHub use case).

### Session 024

- Date: 2026-11-17
- Goal: execute `LAS-173` (labels, relations, and the GitHub use case), step 3's
  final resource slice of the `LAS-167` refactor. No observable behavior change.
- Completed: `LabelRepository` (`replace`) and `RelationRepository` (`add`) in
  `src/application/ports.ts`, with `TransactionPorts.labels` and `.relations`;
  `src/adapters/postgres/repositories/labels.ts` (`createLabelRepository`) and
  `relations.ts` (`createRelationRepository`), both wired in `bindPorts`;
  `src/application/labels.ts`, `relations.ts`, and `github.ts` holding
  `setIssueLabels`, `addRelation`, and `applyPullRequestEvent`;
  `src/services/labels.ts`, `relations.ts`, and `github.ts` deleted with the
  directory. `src/http/app.ts` passes `ports` to the label and relation routes
  and `CreateAppOptions` lost `db`, with `src/server.ts` and six test files
  updated. `src/http/webhook.ts` imports the use case from
  `src/application/github.ts` and keeps HMAC verification, the 1 MiB body cap,
  JSON parsing, and the non-POST 404.
- Verification run: `npm run typecheck` green; the targeted `labels`, `relations`,
  `github`, `cli`, `http`, and `sse` suites 93 pass; full `npm test` 189 pass,
  0 fail; a live `node src/server.ts` smoke exercised the label route (trim,
  dedupe, ascending payload, empty-array clear), the relation route (self-relation
  `400 validation`, unknown-blocker `404 not_found`, idempotent replay writing
  one `relation` event), and the issue detail payload.
- Evidence captured: test diffs are imports, `testDb.db` to `testDb.ports` first
  arguments, and removed `db` options; no assertion, fixture, SQL string,
  message, or expected value changed. The label SQL is the same three statements
  inside the repository, and the relation insert is the same idempotent
  statement.
- Known risk: `src/http/webhook.ts` still owns signature verification and
  payload parsing until step 4; `createApp` still builds the event hub;
  `src/db.ts` still owns the pool; the import-direction check is still planned,
  so layering stays review-only.
- Next best step: step 4 (move the inbound adapters under `src/adapters/`, add
  `src/composition/`, delete `src/db.ts`, and move event-hub construction out of
  `createApp`).

### Session 025

- Date: 2026-11-17
- Goal: execute `LAS-174` (rewire inbound adapters and delete the old layers),
  step 4 of the `LAS-167` refactor plus the import-direction gate. No observable
  behavior change.
- Completed: the tree is now `src/{domain,application,adapters,composition}`.
  Outbound: `src/adapters/postgres/pool.ts` (verbatim `src/db.ts` move),
  `migrate.ts` (runner plus ledger SQL; `runMigrations` requires `databaseUrl`
  and reads no config), `event-hub.ts` (LISTEN client implementing the new
  `EventHub` port in `src/application/ports.ts`), and
  `src/adapters/timing-safe.ts` (`constantTimeEqual`). Inbound:
  `src/adapters/http/{app,transport,auth,errors,webhook}.ts`,
  `src/adapters/mcp/{server,tools}.ts`, `src/adapters/cli/cli.ts`,
  `src/adapters/github/{signature,payload}.ts`, `src/adapters/sse/stream.ts`,
  `src/adapters/static/spa.ts`. Composition: `src/composition/{config,server,cli,mcp,migrate}.ts`.
  Deleted with no shims: `src/db.ts`, `src/config.ts`, `src/migrate.ts`,
  `src/server.ts`, `src/cli.ts`, `src/http/`, `src/mcp/`. `createApp` now
  requires `ports` and an injected `events: EventHub`, takes no `databaseUrl`,
  and exposes no `close()`; `src/composition/server.ts` owns the hub and the
  shutdown order (hub, server, db). `runCli(argv, deps)` and `CliDeps` split argv
  and output from config/pool ownership; MCP `resolveAgentFromToken(ports,
  agentToken)` no longer sees `Config`. `package.json` scripts and
  `scripts/db.sh` point at the composition entrypoints.
- Architecture gate: `scripts/check-architecture.mjs` walks `src/**` and
  `web/src/**`, applies nine import-direction rules, prints
  `path: forbidden import "specifier" (rule)`, exits 1 on violation, and runs in
  `npm run check` via `check:arch`; `test/architecture.test.ts` proves the real
  repo passes and four fixtures fail.
- Verification run: `npm run typecheck` green; `node scripts/check-architecture.mjs`
  printed `architecture: ok (68 files)`; `./scripts/init.sh --no-install` green
  (database, check, vite build); `npm test` 194 pass, 0 fail (189 existing plus
  5 architecture cases); live smoke of `node src/composition/server.ts` on 4790:
  `/api/me` 200 with the UI bearer, unauthenticated 401 `not_authenticated`,
  `/api/projects` through the ports, `/api/events` cookie-only `event: ready`
  frame, `/` 200 SPA from `web/dist`; `node src/composition/cli.ts project list`
  printed `CRV\tCurved`.
- Evidence captured: test changes are adapter import paths, `createApp` options
  with a real hub, and the two spawn entrypoints; no assertion moved. The SQL
  invariants, route tables, status codes, error codes, CLI output, MCP results,
  and SSE frames are unchanged. The only user-visible text change is the MCP
  `no agent token` hint path, now `node src/composition/cli.ts agent add <name>`;
  no test pinned the old path.
- Known risk: the architecture check is path-based and catches neither a
  duplicated rule nor browser globals, so those stay review items. `web/src` is
  still the step-5 target layout (`lib/`, `app.tsx`), and the web rules in the
  check currently pass trivially.
- Next best step: step 5 (web layering: split `web/src` into `domain/`,
  `application/`, `adapters/`, `ui/`, delete `web/src/lib/`, move orchestration
  out of `web/src/app.tsx`).

### Session 026

- Date: 2026-11-17
- Goal: close `LAS-171` (issue lifecycle and read model on ports), which the
  tracker still showed as Todo even though the work landed in `7342d04`.
- Completed: audited all ten acceptance criteria against `HEAD` (`867d57e`) with
  four read-only slices; every criterion passes and no code change was needed.
  Criterion 1: `src/application/issues.ts` and `issue-read-model.ts` import only
  domain and `./ports.ts`, with no SQL, no `pg`, no `node:*`. Criterion 2:
  `IssueRepository` declares create (one data-modifying CTE that bumps
  `projects.next_number` and inserts, so allocation is atomic and gap-free),
  findById, findByKey, lockByKey (`for update`), filtered list, updateFields,
  and updateStatus writing `status` and `claimed_by` in one statement. Criterion
  3: `issue-events.ts` appends one row and lists `order by id asc`; the 23001
  trigger is the only enforcement. Criterion 4: `issue-meta.ts` runs exactly two
  statements for labels and relations (zero for an empty batch). Criterion 5:
  `toIssue` derives `allowedTransitions` from `domain/actors.ts` and attaches
  meta; no derived column exists in the schema. Criterion 6: create and move
  run entirely inside `ports.transaction`; create's row reload is the read-back
  inside `IssueRepository.create`, and move does lock, checks, update, one
  event, and `hydrateIssue`. Criterion 7: `23505` on
  `issues_one_active_claim_per_agent` becomes `ActiveClaimConflict` and then
  `agent_busy` naming the active key, in both `moveIssue` and `claimNext`.
  Criterion 8: the list path is exactly three statements (row query, labels,
  relations), pinned by `test/labels.test.ts`. Criterion 9: the full test diff
  for `7342d04` and the range `b079662^..867d57e` shows only import paths,
  `testDb.db` to `testDb.ports`, and `listEvents`/`appendEvent` to
  `ports.events.*`; the 23001 trigger, 23505 fence, statement budget, and
  concurrency assertions are unchanged. Criterion 10: every HTTP issue route,
  CLI issue command, and MCP tool enters the application layer with ports.
- Verification run: `npm run check` green (typecheck, `architecture: ok`, 194
  tests, 0 fail). End-to-end smoke on a disposable `curved_test_e2e171`
  database: HTTP sign-in, project create, issue create/patch/transition
  (legal and illegal), labels, relation, comment, list and status filter,
  unknown-project 404, ready; CLI `issue show`, `issue list`, `issue move`; MCP
  over stdio `get_issue` (labels, relations, `allowedTransitions`),
  `list_ready`, `claim_next`, second `claim_next` returning
  `agent_busy` naming the held key, `comment`, `submit_for_review`,
  `create_issue`, and a non-owned `mark_blocked` rejected with
  `forbidden_transition`. The throwaway database and smoke script were removed.
- Tracker: `LAS-171` moved to Done with the audit evidence in a comment. No
  behavior, error-code, message, or test-assertion change; the commit that
  follows carries this MEMORY entry only.
- Known risk: the three list statements run on pool connections rather than one
  snapshot transaction (pre-existing behavior), so a concurrent label write can
  appear between reads; a non-agent `ActiveClaimConflict` would escape
  untranslated, but `nextClaimedBy` makes that unreachable.
- Next best step: step 5 (web layering).

### Session 027

- Date: 2026-11-17
- Goal: execute `LAS-175` (web layering), step 5 of the `LAS-167` refactor.
  No observable behavior change.
- Completed: `web/src` is now `domain/`, `application/`, `adapters/`, `ui/`, and
  `main.tsx`. `domain/` holds `types.ts` (contract types, `NewIssueInput`, and
  the toast types), `presentation.ts` (label and tone maps plus the formatting
  helpers), and the React-free `routes.ts`. `application/` holds `errors.ts`
  (`ApplicationError`, `isApplicationError`, `isUnauthorized`, `messageOf`),
  `ports.ts` (`ApiPort`, `RealtimePort`, `NavigationPort`,
  `IssuesChangedOptions`), and `workspace.ts` (`AuthState`, `WorkspaceDeps`,
  `Workspace`, `useWorkspace`) with all orchestration and no JSX, `fetch`,
  `EventSource`, or history write. `adapters/` holds `api-client.ts`
  (`createApiClient`), `realtime.ts` (`useIssuesChanged` plus `realtime`), and
  `history.ts` (`useHistoryRouter` plus `NAVIGATE_EVENT`). `ui/` holds React and
  styles only, with `AppView.tsx` rendering every gate from one `workspace`
  prop and `Boot.tsx` holding the boot screen and error card; `SignIn` moved to
  `onSignIn(token): Promise<void>` and `ProjectSetup` to
  `onCreate(input): Promise<Project>` with `onCreated` and `onSignOut`.
  `main.tsx` is the composition root that builds the fetch client, runs the
  history and realtime hooks, injects the three ports into `useWorkspace`, and
  renders `AppView`. Deleted with no shims: `web/src/app.tsx`, `web/src/lib/`,
  `web/src/components/`, and the root `web/src/styles.css`.
- Evidence and gates: `npm run typecheck` green; `npm run check:arch` printed
  `architecture: ok (74 files)`; `npm run build` green; `npm test` 195 pass, 0
  fail (189 behavior plus 6 architecture), where the architecture suite now
  proves five fixture trees fail (application -> adapter, domain -> `pg`, web ui
  -> adapter, web application -> adapter, web domain -> backend module). Browser
  smoke: 390x844 (five-status bar with 44 px targets, 56 px bottom nav, 120 px
  bottom scroll padding, per-status counts) and 1440x900 (236 px sidebar, five
  flex columns, `overflow-x: auto`); sign-out; sign-in with a rejected and an
  accepted token; first-run project setup on a throwaway database (validation
  message, create, toast, empty board) that was dropped afterward; board; ready
  queue; issue detail transition and comment; `Ctrl/Cmd+K` palette; cross-tab
  SSE where a CLI comment and a CLI-created issue appeared in both open tabs
  without reload. No console errors.
- Tracker: `LAS-175` moved to Done. The commit follows this entry.
- Known risk: the architecture check stays path-based, so a duplicated rule, a
  browser global inside `ui/`, or a component importing an adapter through a
  re-export would still need review eyes. `web/src` now imports the backend
  status contract only through `domain/types.ts` and `domain/presentation.ts`.
- Next best step: `LAS-176` (the refactor completion gate and handoff).

### Session 028

- Date: 2026-11-17
- Goal: close `LAS-176`, the completion gate of the `LAS-167` refactor, and
  hand the contract off. No behavior change.
- Completed: a static boundary audit of `src/domain/` and `src/application/`, a
  behavior audit over `899e62f..c97af0f`, a full baseline and suite re-run, and
  runtime smokes of every real entry point, then this handoff. `AGENTS.md` and
  this file now describe the verified final structure, the gates with their
  numbers, and the intentional deviations.
- Evidence: `./scripts/init.sh` and `./scripts/clean-state.sh` both green, with
  install "up to date", the database healthy and "already up to date",
  `npm run check` green, `architecture: ok (74 files)`, `npm test` 195 pass and
  0 fail (189 behavior plus 6 architecture), the vite build writing `web/dist`,
  and codegraph "Already up to date". Boundary audit: `src/domain/` is 9 files
  with 16 import specifiers, all sibling domain modules and no package
  specifier; `src/application/` is 11 files importing only `../domain/*.ts`,
  `./ports.ts`, and its own use-case modules, with no `pg`, `node:*`, `react`,
  crypto, adapter, composition, or `process.env` reference. All 12 old-layer
  paths are absent (`src/services/`, `src/db.ts`, `src/config.ts`,
  `src/migrate.ts`, `src/server.ts`, `src/cli.ts`, `src/http/`, `src/mcp/`,
  `web/src/app.tsx`, `web/src/lib/`, `web/src/components/`, and
  `web/src/styles.css`), and no `export ... from` shim exists in `src/` or
  `web/src/`. Behavior audit over `899e62f..c97af0f` (899e62f is the commit
  before `LAS-169`; b079662 is `LAS-169` itself) found no unrecorded product
  behavior difference: the test deltas are imports, `testDb.db` to
  `testDb.ports`, `createApp` options, spawn paths, helper calls, three
  semantically identical expression updates (`hashAgentToken` to
  `createTokenCodec().hash`, the rollback test using the transaction handle it
  tests, and the missing-build test de-wrapped because `App.close` is gone),
  and the architecture fixture rename `web/src/lib` to `web/src/domain` plus
  one new case (189 to 195 tests). Internal seams changed: `createApp` takes an
  injected `EventHub` and has no `close()`, and the history hook memoizes route
  and navigate. Runtime smokes, each on a throwaway `curved_test_*e2e176*`
  database dropped afterward with no listeners left: the CLI project, issue,
  and agent commands (`created project TAC (Toolchain)`, a `project list` line
  reading `TAC` and `Toolchain` separated by a tab,
  `created issue TAC-1 (First issue)`, list, show, move, and a minted `crv_`
  token); MCP over stdio with that real token, listing exactly the eight tools
  and exercising `list_ready`, `claim_next`, the `agent_busy` fence,
  `comment`, `submit_for_review`, `get_issue`, `release_claim` from
  `in_review` (`illegal_transition`), `mark_blocked`, `create_issue`, and a
  bogus token (`not_authenticated: agent token is not valid`); HTTP plus SSE in
  Chromium at 1440x900 and 390x844, with the built SPA and its assets 200, a
  rejected UI token inline, the `curved_session` cookie, first-run setup, the
  five-lane board with counts, CLI writes appearing in two tabs without reload,
  the deep-linked detail timeline, `Ctrl/Cmd+K`, 44x78 px phone tabs, a first
  `event: ready` frame, reconnect from `readyState=2` to `readyState=1` about
  5 ms after a restarted server accepted connections, 0 console entries on
  clean loads, and a JSON 404 for unknown `/api` paths; and the GitHub webhook,
  where a valid signed `opened` pull request moved an `in_progress` issue to
  `in_review` with exactly one `git` status event, a replay answered
  `{"ok":true,"ignored":true}` with no second event, wrong and missing
  signatures returned 401, unknown keys, `push`, and unmerged closes answered
  200 ignored, malformed JSON with a valid signature returned 400, a merged
  close moved `in_review` to done, `GET` returned 404, and a server without
  `GITHUB_WEBHOOK_SECRET` returned 503 `webhook_not_configured` with data
  untouched.
- Tracker: `LAS-176` and the parent `LAS-167` are Done, recorded after the gate
  passed. `LAS-151` shows In Review; `LAS-153` and `LAS-154` remain open with
  acceptance tests outstanding.
- Known risk: the architecture check is still path-based, so a duplicated rule
  or a browser global reached through a re-export needs review eyes; there is
  still no frontend test runner, so the browser pass is manual.
- Next best step: `LAS-155` (the end-to-end acceptance gate).

### Session 029

- Date: 2026-11-17
- Goal: close `LAS-155`, the end-to-end acceptance gate. No product behavior
  change; the only UI change is inert test hooks.
- Completed: `npm run acceptance` is the repeatable gate.
  `scripts/acceptance.sh` starts Postgres with `bash scripts/db.sh
  --no-migrate`, always rebuilds `web/dist`, then runs
  `scripts/acceptance.mjs`. The orchestrator creates and migrates one
  `curved_acceptance_<pid>_<epoch>` database and runs every leg against it: the
  CLI lifecycle (project, agent, Todo issue, ready with `busy: -`, claim, second
  claim `agent_busy`, review, `busy: TAC-1` while in review, human move to done,
  empty ready, `no_ready_issue`), the NDJSON MCP handshake with exactly the
  eight tools, `npm start` on a free port, the UI bearer plus the session
  cookie and the `ready` and `issues_changed` SSE frames, a signed
  `pull_request` webhook that moves an issue to In Review plus its ignored
  replay, and `scripts/acceptance-browser.mjs`. That browser leg is a
  dependency-free Chromium/CDP driver at 390x844 that signs in, asserts the five
  status tabs with counts, creates an issue through `Ctrl+K` and the palette,
  posts a comment, and proves a second tab updates in under 1100ms (observed
  46ms). Cleanup stops children newest-first, drops the database unless
  `--keep`, and re-digests `projects`, `issues`, `issue_events`, `agents`,
  `labels`, `issue_labels`, `issue_relations`, and `schema_migrations` in the
  default `curved` database, failing on any change; `SIGINT`/`SIGTERM` runs the
  same shutdown. `scripts/db.sh` gained `--no-migrate`. `web/src/ui` gained inert
  `data-testid` hooks (board tabs, cards, rows, empty state; new-issue fields;
  detail transitions, comment, timeline; sign-in; setup; toasts) plus optional
  `testId` props on `Modal` and `EmptyState`, with no behavior, copy, or layout
  change. `README.md` and `AGENTS.md` document the gate and its commands.
- Evidence: `./scripts/init.sh` green (install, database, check, build; 195
  tests, `architecture: ok`); `npm run acceptance` green twice, 72-73 checks,
  on a fresh build with `web/dist` deleted, and with a SIGINT mid-run leaving no
  server, chromium, or acceptance database behind; the default `curved` row
  counts (`projects` 1, `issues` 30, `issue_events` 113, `agents` 5) were
  identical before and after a full `npm test`, proving suite isolation on
  `curved_test`; the board screenshot was measured programmatically (five equal
  tabs 44.5 CSS px tall with counts, two issue rows, no clipping or overlap);
  `./scripts/clean-state.sh` green.
- Deviations: the webhook leg asserts the agent claim survives the `git` move to
  in_review (`claimedBy: "beta"`), matching `nextClaimedBy` and
  `test/github.test.ts`, not the ticket brief's "claim cleared". The acceptance
  wrapper always rebuilds `web/dist` so the browser leg cannot pass on stale
  assets.
- Tracker: `LAS-155` is Done. `LAS-151` shows In Review; `LAS-153` and `LAS-154`
  remain open with acceptance tests outstanding.
- Known risk: the mobile toast overlays the comment composer for its 5s lifetime
  and the muted pill text measures about 4.04:1 contrast; both are pre-existing
  palette/layout traits, recorded rather than changed here. The browser leg needs
  a local Chromium and Docker.
- Next best step: `LAS-153` (issue detail and human actions acceptance tests).

### Session 030

- Date: 2026-11-17
- Goal: re-check the three stale open issues and close the ones that already
  meet their acceptance criteria.
- Completed: `LAS-153` and `LAS-151` passed every acceptance criterion with no
  code change and are Done. `LAS-154` failed two criteria in the real browser;
  both are fixed. Issue result rows now render the issue key in a
  `[data-testid="palette-key"]` span (filtering by key previously matched
  invisibly), the issue result cap went from 8 to 50, the listbox is a capped
  flex column (`max-h-[calc(100dvh-12vh-1rem)]`, `min-h-0 flex-1
  overflow-y-auto`, `scroll-pb-1.5`) instead of `max-h-[min(26rem,60vh)]`, and
  an effect scrolls the active option into view with a 6px bottom gutter.
  `scripts/acceptance.mjs` now seeds 24 backlog issues over the human bearer
  (`palette-seed` leg) so the palette list overflows, and
  `scripts/acceptance-browser.mjs` asserts a unique lowercase key query renders
  the uppercase key span and that ArrowDown to the last of 31 options leaves the
  selected row fully inside the scrolled listbox with at least a 4px bottom
  gutter; it also captures a palette screenshot.
- Evidence: verification ran against throwaway databases with the real entry
  points and no repo edits. `LAS-153`: 8/8 criteria in headless Chromium at
  390x844 and 1440x900 (whitespace-preserving description, comment 3 -> 4 events
  with one navigation entry, exactly one button per `allowedTransitions`, unblock
  with reason, edits, new-issue navigation to TAC-6, blocked queue state, human
  vs agent `allowedTransitions` and 403s, a forced-payload render check, both
  viewports). `LAS-151`: 8/8 criteria over HTTP and CLI, 29 checks, including
  503, 401, raw-body HMAC, opened/reopened/merged/unmerged, title-derived and
  padded keys, ignored replays with unchanged event counts, git events, and
  `git-branch TAC-014` -> `TAC-14-...`. `LAS-154`: palette fix verified by
  `npm run acceptance`, 145 checks, palette key search `tac-4` -> visible
  `TAC-4`, and the last of 31 options selected with `scrollTop 530` and a 5.7px
  bottom gutter. `./scripts/init.sh` green after the fix.
- Deviations: none in product behavior beyond the two palette fixes; the
  palette now lists up to 50 matching issues instead of 8, which the "finds any
  issue" criterion requires.
- Tracker: `LAS-151`, `LAS-153`, and `LAS-154` are Done with the verification
  evidence in comments. No Curved issue remains open.
- Known risk: on the active palette row the small uppercase status label
  measures about 3.5:1 contrast, and the active state is carried mostly by the
  amber icon rather than the row background; both are palette design traits,
  recorded not changed.
- Next best step: none open in this project; the next tracker work is outside
  Curved.


