# MEMORY.md

- **Last updated:** 2026-11-10
- **Project:** curved
- **Phase:** issue capture complete (`LAS-142`). Toolchain, Postgres 18, migrations, the projects resource, and the issues resource (atomic keys, append-only events) are live.

## Current verified state

- Repository root: `/home/dietkyle/projects/curved`
- Stack: Node 26.2 running TypeScript directly via type stripping, ESM with explicit
  `.ts` import extensions, `pg`, TypeScript 5.9 strict no-emit typecheck.
- Startup path: `./scripts/init.sh` runs install, database, check, build.
  `--no-install` skips only install; the database step still runs.
- End-of-session gate: `./scripts/clean-state.sh`
- Baseline: green. `npm run typecheck` covers server and web configs; `npm test`
  runs 30 tests on the Node test runner.
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
  `issue add <PROJECT> <title...>`, `issue list [PROJECT]`, `issue show <KEY>`,
  and `--json`; errors print `<code>: <message>` and exit 1.
- Issue keys are canonical without padding (`TAC-14`); parsing accepts padded input
  such as `TAC-014`.
- Tests: isolated database from `TEST_DATABASE_URL` (name must start with
  `curved_test`), created and migrated by `test/helpers/db.ts`; the development
  database is never touched.
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
- `issues.claimed_by` is plain text until `LAS-145` adds agent identity; the claim
  fence and the transition rules land in `LAS-144` and `LAS-145`.
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
- None blocking. The next slice is fully specified by `LAS-142`.

## Next best step

Execute `LAS-143` and `LAS-144`, both unblocked by `LAS-142`.

## Tracker

- Linear workspace: last-known-good (`LAS`).
- Project: Curved (`P-LAS-8`).
- Spec issue: `LAS-140`, labelled `ready-for-agent`.
- Test seams agreed: service layer (primary), HTTP in-process fetch, raw SQL only
  for the append-only trigger and the partial unique index.
- Sub-issues (15, native `blockedBy` edges):
  - `LAS-141` foundation: toolchain, Postgres, migrations, project creation (done 2026-11-10)
  - `LAS-142` issue capture, atomic keys, append-only events (141) (done 2026-11-10)
  - `LAS-143` comments and timeline read path (142)
  - `LAS-144` status machine and actor matrix (142)
  - `LAS-145` agent identity and claim fence (144)
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
