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
- Projects are human-managed: a project key never changes, and archive is the
  terminal lifecycle action - there is no project delete.

## Startup workflow

1. `pwd` to confirm the repo root.
2. Read `MEMORY.md` for verified state and the next step.
3. `./scripts/init.sh` to prove the baseline.
4. If the baseline is red, fix that before adding features.

## Current state

- Runtime: the CLI (`npm run cli` / `node src/composition/cli.ts`) drives projects, issues, comments, transitions, blocking, and claims; MCP over stdio (`npm run mcp`) exposes the eight agent tools; the HTTP API with SSE (`npm start`, `PORT` default 4747) also serves the built SPA from `web/dist`.
- Operations: a multi-stage Docker image and a production compose stack behind Caddy TLS; `deploy/release.sh` runs the pre-deploy backup and release order, with `deploy/backup.sh` and `deploy/restore.sh` for recovery; the keepalive timer, the agent tunnel, and deployed-commit parity are documented in `deploy/provisioning.md` and `docs/operations.md`.
- Model: the domain layer enforces the status machine and actor matrix, one active issue per agent (partial unique index), an append-only `issue_events` timeline, per-project sequential keys, labels, and blocking relations; projects are human-managed with archive as the terminal action; agents act only through the tool interface; blocked issues are absent from ready and unclaimable.
- Auth: humans use the UI bearer or an opaque `curved_session` cookie, including passkey login; agents present `crv_` bearer tokens. `POST /webhooks/github` verifies `x-hub-signature-256`, then moves pull requests to In Review and merged pull requests to Done as the `git` actor; `git-branch` prints the issue branch.
- Architecture: `ARCH.md` holds `src/domain` -> `src/application` -> `src/adapters` -> `src/composition` under a one-way dependency rule enforced by `scripts/check-architecture.mjs`; the web tree mirrors it as `domain`, `application`, `adapters`, and `ui` with a single `main.tsx` root.
- Gates: baselines live in `MEMORY.md` under `## Current verified state`; this file carries no numbers.
- Next work: `curved ready` plus `MEMORY.md` under `## Next best step`.

## Directory page

| Path | Role |
|---|---|
| `README.md` | Public overview: what Curved is, its invariants, a quick start, and the documentation index. |
| `docs/` | In-depth guides: `workflow.md`, `cli.md`, `api.md`, `clients.md`, `operations.md`, `development.md`. |
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
| `deploy/agent-tunnel.sh` | Agent tunnel: forwards local `55433` to host `127.0.0.1:55432` by default, refuses `55432` to protect local development, and uses strict SSH options. |
| `deploy/agent-preflight.sh` | Agent preflight: compares local `HEAD` to the host `/srv/curved/release-state` sha, and with `--require-tunnel` probes the forward. |
| `deploy/provisioning.md` | OCI console runbook: topology, security list, reserved IPv4, DNS-only record, bootstrap and verifier commands, Docker data root and mount gate, reboot persistence, the public ACME/HSTS edge and webhook evidence, capacity fallback, access boundary, storage, releases and rollback, backups and restore, the keepalive and the rebuild-after-reclamation runbook (section 18), agent access and deployed-commit parity (section 19), public product acceptance including the empty-token and first-run checks (section 20), troubleshooting. |
| `deploy/bootstrap-host.sh` | Idempotent Ubuntu 24.04 host bootstrap: Docker install, Docker data root on the data volume with the mount dependency, log rotation and prune timer, 0700 backup directory with the daily backup timer and one initial nightly set, hourly keepalive units and `/usr/local/bin/curved-keepalive`, key-only `deploy` user and sshd drop-in, ext4 data volume and UUID fstab entry, checkout, mode-600 env, compose up. |
| `deploy/verify-host.sh` | Read-only host verifier: OS, deploy account, sshd policy, ext4 mount, 150 GB storage, Docker data root, daemon config, mount dependency and prune timer, keepalive timer and script, backup directory, timer, freshness and integrity, env, checkout, listener allowlist, stack health, `tls-certificate`, `http-redirect`, `hsts`, `compression`, `caddy-issuance`, the 200/401 HTTPS API, and the webhook signature check (unsigned `401`, signed unknown-key `200`). |
| `deploy/webhook.sh` | Creates or updates the GitHub `pull_request` webhook for the deployed host (default `https://$CURVED_DOMAIN/webhooks/github`), always PATCHing an existing same-URL hook so the secret is reapplied; `--repo`, `--url`, `--env-file`, `--dry-run`. |
| `.github/workflows/verify.yml` | CI gate: push to main plus manual dispatch, Postgres 18 service, typecheck, architecture check, tests, web build; the main-only `deploy` job (`needs: verify`) SSHes with the `DEPLOY_*` secrets and runs `deploy/release.sh`. |
| `.github/workflows/rotate-ui-token.yml` | Manual `workflow_dispatch` token recovery: validates the `DEPLOY_*` and `CURVED_UI_TOKEN` secrets, pipes the token over stdin to `deploy@$DEPLOY_HOST`, atomically rewrites the mode-600 env line with backup and release re-run on failure, runs `deploy/release.sh`, and proves a 200 from `POST /api/session`. Concurrency group `rotate-ui-token`. |
| `src/domain/` | Pure rules and types: status, project-status, and transition contract, actor matrix, claim and move policy, validation, key parsing, domain errors, shared record types. |
| `src/application/` | Ports (`ports.ts`) and the full SQL-free use-case set: `projects.ts` (create, list, get, and update projects with progress), `issues.ts` with `issue-read-model.ts`, `agents.ts`, `queue.ts`, `blocking.ts`, `comments.ts`, `labels.ts`, `relations.ts`, `github.ts`, `sessions.ts` (opaque session creation and `SESSION_MAX_AGE_SECONDS`), and `passkeys.ts` (availability, listing, registration, and login options). |
| `src/adapters/` | Adapters. Inbound: `http/` (router, auth, error mapping, request/response transport, webhook), `mcp/`, `cli/`, `github/` (signature and payload), `sse/`, `static/`. Outbound: `postgres/` (`pool.ts`, `migrate.ts`, `event-hub.ts`, `ports.ts` binding the pool and transactions, plus `repositories/`: projects, issues, issue events, issue meta, agents, labels, relations, passkeys, auth sessions, and passkey challenges), `token-codec.ts`, `timing-safe.ts`. |
| `src/composition/` | Composition roots: `config.ts` (`loadConfig`, including WebAuthn origins and RP ID resolution), `server.ts` (HTTP entry, requires `CURVED_UI_TOKEN`, owns the event hub and shutdown), `cli.ts`, `mcp.ts`, `migrate.ts`. |
| `web/src/domain/` | Pure client domain: `types.ts` (contract types including `Project` with progress, `NewProjectInput`, `ProjectPatch`, `NewIssueInput`, toast types), `presentation.ts` (label/tone maps, project status label/tone maps, progress percent, and formatting helpers), `routes.ts` (`Route`, `parseRoute`, and the path builders, including `projectsPath()` and `overviewPath()`). May import only `src/domain/status.ts` from the server. |
| `web/src/application/` | Client ports and orchestration: `errors.ts` (`ApplicationError` and its guards), `ports.ts` (`ApiPort` including project create, detail, update, archive, and restore plus passkey availability, listing, registration, login, and removal, `RealtimePort`, `NavigationPort`, `PasskeyPort`), `workspace.ts` (`useWorkspace` and its types, including the `projectDialog` state, project actions, and passkey state). React hooks allowed; no JSX, no `fetch`, no `EventSource`, no history writes, no credential API. |
| `web/src/adapters/` | Transport adapters: `api-client.ts` (`createApiClient`), `realtime.ts` (`useIssuesChanged`, `realtime`), `history.ts` (`useHistoryRouter`, `NAVIGATE_EVENT`), `passkeys.ts` (`createPasskeysAdapter(): PasskeyPort` over `@simplewebauthn/browser` for support, registration, and authentication). |
| `web/src/ui/` | React and styles only: `AppView.tsx`, `Boot.tsx`, `PasskeysDialog.tsx`, `ProjectsPage.tsx`, `ProjectOverview.tsx`, `ProjectDialog.tsx`, `ProjectStatusChip.tsx`, and the shell, board, queue, detail, dialog, palette, sign-in (passkey button plus the UI-token divider), setup, toast, and primitive components plus `styles.css`. No transport imports. |
| `web/src/main.tsx` | Composition root: creates the API client and passkey adapter, calls the history and realtime adapters, injects all four ports into `useWorkspace`, renders `AppView`. |
| `web/` | Vite + React SPA around `web/src/`. `npm run build` writes `web/dist`; `npm start` serves it; `npm run dev` proxies `/api` to 4747. |
| `skills/` | Three public installer-facing agent skills (`curved-agent`, `curved-cli`, `curved-api`) for using Curved over MCP, the CLI, and HTTP; installed with `npx skills add DietKyle956/Curved`. |
| `scripts/init.sh` | Baseline runner: install, check, build. `--no-install` skips install. |
| `scripts/check-architecture.mjs` | Import-direction check over `src/**/*.ts` and `web/src/**/*.ts(x)`; exits 1 on any violation. |
| `scripts/agent-smoke.sh` | Agent gate (`npm run smoke:agent`): stub `ssh` and a throwaway git fixture over the two deploy helpers, covering the 55432 refusal, strict SSH options, local/deployed parity, and the tunnel probe with no Docker, database, or network. |
| `scripts/clean-state.sh` | End-of-session gate. Idempotent, writes nothing. |
| `scripts/acceptance.sh` | Acceptance entry: `bash scripts/db.sh --no-migrate`, `npm run build:web`, then `scripts/acceptance.mjs` with the caller's flags. |
| `scripts/acceptance.mjs` | End-to-end gate over a throwaway database: CLI (including project add/list/show/edit/archive/restore), MCP, server, HTTP plus SSE (including project detail, `PATCH`, and archive), webhook, palette seed, browser (including the 390 px projects page, project creation at 0%, and the status edit); drops the database and fails if the default `curved` rows changed. `--skip-browser`, `--keep`. |
| `scripts/acceptance-browser.mjs` | Dependency-free Chromium/CDP driver at 390x844 over the built SPA; writes run-scoped screenshots under the system temp dir. `CHROMIUM_BIN` overrides the binary search. |
| `scripts/container-smoke.sh` | Container contract gate: starts the local DB, builds `curved:container-smoke`, and asserts the SPA shell, `401`/`200` on `/api/projects`, `already up to date` from the in-image migrate, a non-root uid, and the absent paths. `--platform`, `--build-only`, `--keep`. |
| `scripts/compose-smoke.sh` | Production compose gate: throwaway project and env, HTTPS through Caddy's internal CA, the HTTP 308 redirect, the HSTS toggle (absent by default, `max-age=31536000` after enabling), gzip on the JS asset, SPA/API/ready/detail assertions, SSE `ready` and `issues_changed` within 5s, unsigned webhook 401, the bind/port checks, and a real nightly backup restored into a throwaway database plus a Caddy volume restore. |
| `scripts/backup-smoke.sh` | Backup and restore gate (`npm run smoke:backup`): stub Docker over the real scripts; set layout, manifest keys, checksums, retention, failure isolation, pre-deploy Caddy skip, `--yes` refusal, checksum tamper, drill versus production restore, and Caddy restore ordering. |
| `scripts/provision-smoke.sh` | Provisioning gate: runs the bootstrap and verifier in a disposable Ubuntu 24.04 container with PATH stubs; fresh and idempotent bootstrap, Docker data-root migration, daemon config, mount dependency, prune timer, keepalive unit/script/idempotent reinstall, backup directory and units, one initial nightly set, container recreation, verifier positive, the `--acme-email` public mode (certificate, redirect, HSTS, compression, ACME issuance), the public negatives (unverified certificate, missing HSTS, HTTP 200 instead of a redirect, missing ACME marker, internal HSTS, unsigned webhook answering 200), wrong-root, disabled prune and keepalive timers, missing/stale/corrupt backup, and inactive backup-timer negatives, and public-5432 and password-auth negatives. |
| `scripts/release-smoke.sh` | Release gate (`npm run smoke:release`): asserts `deploy/release.sh` release order including the pre-deploy backup before build and migration, the pre-deploy backup failure isolation, the first-release probe rule, the probe skip and require flags, the migration-failure exit before any recreate or tag, the public probe's HSTS requirement (matching max-age passes; a missing header or mismatched max-age is fatal and leaves latest and state untouched), and rollback without a backup. |
| `scripts/webhook-smoke.sh` | Webhook gate (`npm run smoke:webhook`): exercises `deploy/webhook.sh` against a stub `gh`; create and update paths (including a hook response without `config.secret`), the dry run, missing secret, localhost guard, and secret secrecy in output and argv. |
| `scripts/webhook-live.sh` | Live webhook drill (`npm run smoke:webhook:live`): opens a real pull request on a throwaway base branch in a real repository, lets GitHub deliver the hook to the deployed app and Postgres, asserts the issue timeline and status transitions, merges, then closes the pull request, deletes the branches and worktree, and archives the drill project; needs `gh` auth, the Curved tunnel, and network, and is not part of CI. |
| `.codegraph/` | Local index, gitignored. Refresh with `codegraph sync`. |

## Working rules

- One work item at a time; keep the tree restartable from `./scripts/init.sh`.
- Prefer boring, explicit code over abstraction. Type the boundaries.
- Do not silently relax a verification rule mid-implementation.
- Record durable state in `MEMORY.md`, not in chat.
- Work on an issue branch, never `main`: `curved git-branch <KEY>` prints it,
  the branch contains the key, and the PR title starts with `<KEY>`. Push the
  branch and open a PR with `gh pr create --base main`; CI (`verify`) runs on
  the PR. Do not push to `main` directly: `.githooks/pre-push` refuses it
  (`scripts/init.sh` sets `core.hooksPath`), and `verify` fails a non-merge
  commit on `main` through `scripts/check-main-merge.sh`. A deliberate
  administrative push may use `git push --no-verify`; CI still checks the
  result. A work item is complete only once its PR is merged to `main` (which
  deploys); that merge moves the issue to Done through the webhook.
- `MEMORY.md` notes ride the work item's PR. If a note is missed before the
  merge, open a follow-up PR; never push it to `main`.

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
4. Commit the work, push the issue branch, and open or update its PR; merge it
   once `verify` is green, then confirm the merge commit is on `origin/main`.
