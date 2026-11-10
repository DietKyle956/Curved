# MEMORY.md

- **Last updated:** 2026-11-10
- **Project:** curved
- **Phase:** agent identity and the claim fence complete (`LAS-145`). Toolchain, Postgres 18, migrations, the projects resource, the issues resource (atomic keys, append-only events), comment events with the full timeline read path, the transition graph with its actor matrix, and token-authenticated agents with the one-active-issue fence are live.

## Current verified state

- Repository root: `/home/dietkyle/projects/curved`
- Stack: Node 26.2 running TypeScript directly via type stripping, ESM with explicit
  `.ts` import extensions, `pg`, TypeScript 5.9 strict no-emit typecheck.
- Startup path: `./scripts/init.sh` runs install, database, check, build.
  `--no-install` skips only install; the database step still runs.
- End-of-session gate: `./scripts/clean-state.sh`
- Baseline: green. `npm run typecheck` covers server and web configs; `npm test`
  runs 58 tests on the Node test runner.
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
  `review <KEY> <summary...>`, `release <KEY>`. `ready` without `--human`, plus
  `claim`, `review`, and `release`, read `CURVED_AGENT_TOKEN`; an absent or invalid
  token fails `not_authenticated` and never falls back to the human actor. `ready`
  JSON is `{ ready, busy }`; human output lists
  `<key>\t<priority>\t<status>\t<title>` then `busy: <key>` or `busy: -`.
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
- Comment ownership: an agent cannot comment on an issue claimed by another agent
  (`forbidden_transition`); the owner, humans, and comments on unclaimed issues are
  allowed. An agent actor requires a registered identity (`validation` when absent,
  `not_found` when unknown).
- `EVENT_KINDS` now includes `review_submitted`; the database check constraint
  mirrors it. `moveIssue` still writes kind `status`; the queue tools write `claim`,
  `review_submitted`, and `release`.
- Tests: isolated database from `TEST_DATABASE_URL` (name must start with
  `curved_test`), created and migrated by `test/helpers/db.ts`; its reset truncates
  `projects` and `agents` with cascade. The development database is never touched.
  `npm test` runs 92 tests, including 22 agent/queue tests in `test/agents.test.ts`,
  the transition suite, comment ownership tests, and the CLI sequence.
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
- `src/shared/status.ts` is the single contract for statuses, priorities, event
  kinds, and actor types; the schema constraints mirror it.
- `src/shared/status.ts` is also the single contract for the transition map and
  actor matrix (`TRANSITIONS`, `ACTOR_TRANSITIONS`, `isLegalTransition`,
  `actorMayTransition`, `allowedTransitions`). The agent claim edge
  (`todo -> in_progress`, unclaimed, named agent) is included because the
  claim-column rule must be reachable; every other agent edge requires ownership.
  `system` actors take no transitions.
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
- The transition rules remain in `src/shared/status.ts` (`LAS-144`).
- Foundation sequence: shared contract modules (`config`, `db`, `errors`) land first,
  then disjoint slices for database, services/CLI, tests, and baseline/docs.
- Migrations take the session advisory lock before creating the ledger, so two
  concurrent first runs serialize instead of racing on `pg_type`.
- `web/` is a real typecheck project with a minimal `web/src/main.ts`; the SPA
  replaces it in `LAS-152`.
- `build` currently equals the no-emit typecheck because the server runs from source
  and the SPA is not bundled yet. `LAS-152` replaces it with the Vite build.

## Open questions

- MCP transport: the spec fixes stdio with the v2 package and a v1 fallback; verify at
  `LAS-147`.
- None blocking. The next slice is fully specified by `LAS-146`.

## Next best step

Execute `LAS-146` (block and unblock), unblocked by `LAS-145`.

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
  - `LAS-146` block and unblock (145)
  - `LAS-147` MCP server over stdio (146)
  - `LAS-148` HTTP API and auth boundary (146)
  - `LAS-149` labels, relations, dependency-aware ready (148)
  - `LAS-150` SSE realtime stream (148)
  - `LAS-151` GitHub webhook and branch helper (148)
  - `LAS-152` SPA sign-in, setup, board (148, 149, 150)
  - `LAS-153` issue detail and human actions (152)
  - `LAS-154` command palette (153)
  - `LAS-155` end-to-end acceptance gate (147, 151, 153, 154)

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
