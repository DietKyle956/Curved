# MEMORY.md

- **Last updated:** 2026-11-18
- **Project:** curved
- **Phase:** product and infrastructure complete through `LAS-184`. Next work is
  `LAS-185` (release script and SSH deploy).

## Current verified state

`AGENTS.md` carries the long current-state narrative and `ARCH.md` the layer
contract; this section is the durable summary. Session-by-session evidence is in
git history and the Linear comments.

- Repository root `/home/dietkyle/projects/curved`, branch `main`, remote
  `origin` (`https://github.com/DietKyle956/Curved.git`), public. `.codegraph/`
  is initialized and gitignored.
- Stack: Node 26.2 running TypeScript directly via type stripping, ESM with
  explicit `.ts` imports, TypeScript 5.9 strict no-emit typecheck for server and
  web, `pg`.
- Gates: `./scripts/init.sh` (install, database, check, build),
  `./scripts/clean-state.sh`, `npm run acceptance`,
  `npm run smoke:container`, `npm run smoke:compose`,
  `npm run smoke:provision`, and `.github/workflows/verify.yml` on every push to
  `main` and manual dispatch.
- Baseline: 196 tests pass (190 behavior, 6 architecture),
  `architecture: ok (74 files)`, web build green.
- Layout: `src/domain/` pure rules and types; `src/application/` ports plus
  SQL-free use cases; `src/adapters/` inbound (`http`, `mcp`, `cli`, `github`,
  `sse`, `static`) and outbound (`postgres`, `token-codec`, `timing-safe`);
  `src/composition/` entry points. `web/src/` mirrors it: `domain/`,
  `application/`, `adapters/`, `ui/`, with `main.tsx` the only composition root.
  The one-way dependency rule is enforced by `scripts/check-architecture.mjs`
  inside `npm run check`.
- Database: `postgres:18-alpine` through `docker compose` on host port 55432
  (user, password, and db all `curved`); `scripts/db.sh` waits, then migrates.
  Migrations apply lexicographically under session advisory lock 727274, one
  transaction per file, with a `schema_migrations` ledger.
- Schema: `projects` (identity id, unique key `^[A-Z][A-Z0-9]{1,9}$`, trimmed
  name 1..200, `next_number`); `issues` (per-project `number`, unique key
  `^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$`, trimmed title 1..500, description, status,
  priority 1..4, optional parent, `blocked_reason`, `claimed_by`, timestamps);
  append-only `issue_events` (UPDATE and DELETE rejected with SQLSTATE 23001);
  `agents` (unique trimmed name 1..100, unique lowercase SHA-256 `token_hash`);
  migration `0004` adds `labels`, `issue_labels`, `issue_relations`; migration
  `0005` adds the `pg_notify` triggers. `issues_one_active_claim_per_agent` is
  the partial unique claim fence and `issues.claimed_by` references
  `agents(name)`.
- State machine: `backlog -> todo`, `todo -> in_progress`, `todo -> backlog`,
  `in_progress -> in_review`, `in_progress -> todo`, `in_review -> done`,
  `in_review -> in_progress`, `done -> todo`. Actor matrix: `human` takes any
  legal edge; `git` takes `in_progress -> in_review` and `in_review -> done`;
  `system` takes none; `agent` claims an unclaimed `todo -> in_progress` with a
  named agent, then only its own `in_progress -> in_review` or
  `in_progress -> todo`. `claimed_by` is set by an agent claim, kept through
  `in_review` and `done`, and cleared on `todo` and `backlog`. Every issue
  payload carries `allowedTransitions`.
- Claims and queue: `claimNext` serializes same-agent claims with
  `pg_advisory_xact_lock(727275, hashtext(agent))`, pre-checks the active claim
  for `agent_busy`, then selects `order by priority, number, key limit 1 for
  update skip locked`; a partial-index violation maps to `agent_busy` naming the
  active key. `listReady` returns unblocked, unclaimed `todo` issues plus the
  caller's busy key as `{ ready, busy }`. `submitForReview`, `releaseClaim`,
  `blockIssue`, and `unblockIssue` append `review_submitted`, `release`,
  `blocked`, and `unblocked` events; a block stores a 1..2000 character reason
  and returns the issue to `todo`, and an unblock is human only.
- CLI (`node src/composition/cli.ts`): `project add|list`,
  `issue add|list|show|comment|move|block|unblock`, `agent add`,
  `ready [PROJECT] [--human]`, `claim`, `review`, `release`,
  `git-branch <KEY> [--json]`, `migrate`. Agent commands read
  `CURVED_AGENT_TOKEN` and never fall back to the human actor; errors print
  `<code>: <message>` and exit 1.
- HTTP (`npm start`, `PORT` default 4747): requires `CURVED_UI_TOKEN`; humans
  authenticate by UI bearer or the `curved_session` cookie (SHA-256 of the UI
  token), agents by `crv_` bearer; routes cover `/api/me`, `/api/session`,
  projects, issues (list with `project` and `status` filters, create, show,
  human-only `PATCH`), transition, comments, labels, relations, block, unblock,
  release, `/api/ready`, `/api/claims/next`, cookie-only `/api/events`, and
  `/webhooks/github`. Errors are `{ error: { code, message } }` with 400, 401,
  403, 404, 409, and 500 mapping. Non-`/api` paths serve `web/dist` with
  no-cache documents and immutable `/assets/*`, or a 503 naming the build.
- MCP (`npm run mcp`): v2 `@modelcontextprotocol/server` over stdio with exactly
  `claim_next`, `comment`, `create_issue`, `get_issue`, `list_ready`,
  `mark_blocked`, `release_claim`, and `submit_for_review`, thin over the
  application layer and authenticated by `CURVED_AGENT_TOKEN` per call.
- SSE: `GET /api/events` is cookie-only because `EventSource` sets no headers;
  frames are `ready`, `issues_changed` with the project id, and `ping` every 25
  seconds. One lazily opened shared LISTEN client per process implements the
  `EventHub` port with a guarded 1s reconnect; the SPA holds one `EventSource`
  and refetches.
- Webhook: `POST /webhooks/github` verifies the `x-hub-signature-256` HMAC of
  the raw body against `GITHUB_WEBHOOK_SECRET` before parsing, moves
  `pull_request` `opened` and `reopened` to In Review and merged `closed` to Done
  as the `git` actor, and answers `200 {"ok":true,"ignored":true}` for unknown
  keys, illegal transitions, replays, and non-PR events. A missing secret is
  `503 webhook_not_configured`.
- Web: Vite 8 + React 19 + Tailwind v4 SPA in `web/`; sign-in, first-run setup,
  five-lane board with drag gated by `allowedTransitions`, mobile status list,
  ready queue, issue detail modal, label and relation editing, `Ctrl/Cmd+K`
  palette, toasts. Fixed warm near-black palette, Instrument Sans + JetBrains
  Mono, self-hosted fonts, no light mode, `lg` breakpoint overridden to 900 px.
- Config: `DATABASE_URL`, `TEST_DATABASE_URL`, `CURVED_UI_TOKEN`,
  `GITHUB_WEBHOOK_SECRET`, `PORT` (4747), and `COOKIE_SECURE` (opt-in `Secure`
  on the session cookie; unset, empty, `0`, or `false` is off, `1` or `true` is
  on, anything else throws naming the variable).
- Tests: isolated database from `TEST_DATABASE_URL` (name must start with
  `curved_test`), created and migrated by `test/helpers/db.ts` and truncated
  between tests; the development database is never touched.
- Acceptance (`npm run acceptance`): CLI lifecycle, the eight-tool MCP
  handshake, HTTP plus SSE, a signed webhook with replay, a 24-issue palette
  seed, and a Chromium/CDP browser leg at 390x844, all against one throwaway
  `curved_acceptance_<pid>_<epoch>` database that is dropped afterward. It fails
  if a per-table digest of the default `curved` database changes. Flags
  `--skip-browser` and `--keep`.
- Deploy: root `Dockerfile` (multi-stage `node:26-slim`, build then prune,
  runtime as `USER node`) and `deploy/` (compose project `curved-prod`: `db` on
  `127.0.0.1:55432`, `app` running migrations then the server with no host port,
  `caddy` publishing 80/443 TCP+UDP). An empty `ACME_EMAIL` selects Caddy's
  internal CA; a set email switches to ACME. Host ports and the image tag are
  compose variables. Agents reach the deployed Postgres through an SSH tunnel
  (55433 is the future convention).
- Provisioning (`LAS-183`): `deploy/provisioning.md` is the OCI console runbook
  for one Always Free `VM.Standard.A1.Flex` (2 OCPU, 12 GB, Ubuntu 24.04
  aarch64, home region), a 50 GB boot volume plus a 100 GB block volume, a
  reserved public IPv4, a DNS-only `A` record, and a security list limited to
  22/tcp, 80/tcp, 443/tcp, and 443/udp. `deploy/bootstrap-host.sh` is idempotent
  (Docker from Ubuntu packages with the Docker-repo compose fallback, key-only
  `deploy` user in the `docker` group, `00-curved-access.conf` sshd drop-in,
  ext4 data volume at `/srv/curved` with a UUID `nofail` fstab entry, checkout at
  `/srv/curved/checkout`, one generated mode-600 `deploy/.env`, compose up with
  Caddy's internal CA). `deploy/verify-host.sh` is read-only and checks the OS,
  deploy account, sshd policy, ext4 mount, 150 of 200 GB block storage, env,
  checkout, listener allowlist, stack health, and the authenticated HTTPS API.
  `npm run smoke:provision` runs both scripts in a disposable `ubuntu:24.04`
  container with PATH stubs. The OCI console steps and live host checks are
  operator-executed; no Terraform or Resource Manager.
- Durable data root (`LAS-184`): bootstrap mounts the data volume before Docker
  may start, creates `/srv/curved/docker` (root:root 0710), and writes the
  managed `/etc/docker/daemon.json` (`data-root`, `json-file` `10m` x `3`,
  builder GC `5GB`). The docker.service drop-in sets
  `RequiresMountsFor=/srv/curved/docker` and
  `ConditionPathIsMountPoint=/srv/curved`. `curved-docker-prune.service` and a
  daily 04:37 timer prune build cache older than 168h and unused images older
  than 720h. An existing `/var/lib/docker` is copied once with `cp -a`, the old
  tree is kept, and the migrated root is re-chmoded 0710. The run that changes
  `daemon.json` recreates the Compose containers so the logging defaults reach
  Postgres, app, and Caddy. `verify-host` adds `docker-root`, `docker-config`,
  `docker-mount-dependency`, and `docker-prune-timer`, and
  `provision-smoke` proves the migration, config, mount gate, timer, container
  recreation, rerun idempotency, and two verifier negatives.
- CI: `.github/workflows/verify.yml`, one global concurrency group `verify` with
  `cancel-in-progress: false`, a Postgres 18 service on 55432, then `npm ci`,
  `typecheck`, `check:arch`, `test`, and `build:web`. There is no deploy job yet;
  `LAS-185` must declare `needs: verify`.
- Tracker: Linear workspace last-known-good (`LAS`), project Curved
  (`P-LAS-8`). Test seams: application layer primary, HTTP in-process fetch, raw
  SQL only for the append-only trigger and the partial unique index.

## Decisions

- TypeScript + Node 26, mobile-first UI, agent-first API, Postgres as the store.
  The state machine and the agent tool interface are the product; the board is a
  client.
- `src/domain/status.ts` is the single contract for statuses, priorities, event
  kinds, and actor types; schema CHECK constraints mirror it. Key regexes exist
  only in `domain/keys.ts`, except the MCP zod schema, which pins a grouped-free
  copy of the issue pattern because the domain pattern has capture groups.
- `TRANSITIONS`, `LEGAL_EDGES`, and `ACTOR_TRANSITIONS` live in
  `domain/transition.ts` and `domain/actors.ts`, and
  `ACTOR_TRANSITIONS.human` is derived from `LEGAL_EDGES` rather than a second
  edge list; that keeps the domain import graph acyclic. `allowedTransitions`
  lives next to the matrix, so `transition.ts` never imports it.
- Issue creation allocates the number with one CTE that bumps
  `projects.next_number` and inserts the row, and appends the `created` event in
  the same transaction, so an issue never lacks history.
- The claim fence is one active issue per agent, global across projects, over
  `in_progress` and `in_review`; `done` keeps `claimed_by` as history but is not
  active. The unique index is the real fence and the pre-check exists only to
  name the busy key. `0003` backfills pre-fence names with unusable hashes and
  demotes duplicate active claims before adding the FK and the index.
- `claimNext` uses advisory lock namespace 727275 so a losing same-agent claim
  sees the committed claim and gets `agent_busy`; different agents race through
  `skip locked` and the loser gets `no_ready_issue`. Migrations use 727274.
- Tokens are minted once, printed once, and stored only as SHA-256 hex; a
  missing token never implies the human actor. HTTP auth hashes the bearer and
  resolves by `token_hash`; blank and unknown tokens are both
  `not_authenticated`.
- `review_submitted`, `blocked`, and `unblocked` are distinct event kinds beside
  the generic `status`: the queue tools record the tool-level action while
  `issue move` stays the generic path. Blocking is a reason plus `todo`, not a
  sixth status.
- Relations are blocking-only directed edges shaped `{ blocks, blockedBy }`
  (`blocks` points out, `blockedBy` points in). Labels are per project and a set
  replacement rewrites `issue_labels` wholesale; label rows are never deleted
  and the event body is the full sorted set. Cycles are recorded as given and
  keep the affected issues out of `ready` until a human breaks them.
- Label and relation writes are human-only HTTP surfaces, not CLI verbs or MCP
  tools; agents consume them through issue payloads and the dependency-aware
  queue.
- Realtime notifications are refetch hints, never payloads: a row trigger (not a
  service hook) keeps Postgres the source of truth, so any writer notifies. A
  field edit also notifies even though `updateIssue` appends no event. SSE auth
  is cookie-only because `EventSource` cannot set request headers, which makes
  the stream a human-board feature rather than part of the agent surface. The
  hub owns its LISTEN client unless one is injected, and shutdown closes only
  what it owns.
- MCP targets the v2 `@modelcontextprotocol/server` 2.4.0 with `serveStdio`, not
  the v1 SDK. Handlers are zod-validated in the adapter and thin over the
  application layer; schema failures surface as `isError` results beginning
  `Input validation error: Invalid arguments for tool ...`. The process exits
  when stdin ends or on SIGINT/SIGTERM.
- The webhook lives outside `/api` and outside both auth lanes: the HMAC of the
  raw body is the only credential, and verification runs before `JSON.parse`.
  Every outcome that is not an applied move returns `200` with `ignored: true`,
  because a non-2xx makes GitHub retry a delivery that could never succeed;
  replays need no dedupe table because a repeat move is already an illegal
  transition. Moves reuse the `git` actor and the transition graph, so a pull
  request cannot claim work or jump `todo` to review. `action` and `number` are
  read from the payload top level first, with the nested `pull_request` fields as
  fallbacks.
- `git-branch` prints the canonical key plus a lowercased, 60-character title
  slug, so the branch is readable and parses back through `issueKeyFromText`.
- Hexagonal layering: `ports.ts` is the only port module, `TransactionPorts`
  has no `transaction` member so a nested transaction cannot typecheck, error
  translation happens once per boundary (23505 to `duplicate`, the partial index
  to `ActiveClaimConflict` then `agent_busy`), and HTTP status mapping lives
  only in the HTTP adapter. Old layers were deleted with no re-export shims.
- The SPA uses each issue's `allowedTransitions` as the only drag-and-drop
  source of truth and never re-implements the graph client-side. The shell is
  fixed to the viewport; the board owns its horizontal scroll. `Dialog` and the
  issue detail share one `Modal` shell (focus trap, Escape and backdrop close,
  scroll lock, full-screen sheet below `sm`).
- No frontend test framework was added; the browser acceptance leg plus manual
  Chromium passes are the coverage. Verification ran at 1440, 1024, and 390 px.
- Session cookies carry `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` and add
  `Secure` only under `COOKIE_SECURE`, so local HTTP development keeps its
  default while production compose sets `COOKIE_SECURE=1`.
- The production compose `app` runs the idempotent migration command before the
  server so one `up` reaches a healthy schema; `LAS-185` still runs migrations
  separately in the release script. Local TLS uses Caddy's internal CA; ACME
  issuance is production-only.
- Provisioning is console-driven, not Terraform: `deploy/provisioning.md` and
  the two host scripts are the source of truth. Bootstrap is idempotent, only
  formats a device that has no filesystem, and refuses the root disk, a whole
  disk with partition children, `/` as a mount or checkout path, and equal mount
  and checkout paths. The data-volume fstab entry keeps `nofail` so a missing
  volume never blocks boot, while the docker.service drop-in's
  `RequiresMountsFor` plus `ConditionPathIsMountPoint` make Docker refuse to
  start on an empty `/srv/curved`. Docker's data root is `/srv/curved/docker`
  with a managed `daemon.json`; the global log rotation is `json-file` 10 MB x 3
  and build cache keeps 5 GB. The daily prune timer is explicit host hygiene on
  top of that GC. A first-run or changed daemon config recreates the Compose
  containers with `--force-recreate`, because Docker logging defaults only reach
  new containers. The `deploy` user is root-equivalent
  through the docker group and is documented as such. `deploy/.env` is generated
  once, never overwritten, never printed, and rejected while it still contains
  `change-me`.
- The CI gate is one workflow with one concurrency group and no deploy job. A
  pending run is replaced by a newer queued run, but an in-flight run is never
  cancelled.

## Known risks

- The architecture gate is path-based: a duplicated rule, a browser global inside
  `ui/`, or an adapter reached through a re-export still needs review eyes.
- No component test framework: browser coverage is the acceptance CDP leg plus
  manual Chromium passes.
- The event hub keeps its LISTEN client open after the last subscriber until
  shutdown, and the architecture keeps one LISTEN backend per process.
- `listIssues` runs its three statements on pool connections rather than one
  snapshot transaction, so a concurrent label write can land between reads.
- Blocking-relation cycles are permitted and keep the affected issues out of
  `ready`; there is no cycle detection.
- Palette traits recorded, not changed: the active palette status label is about
  3.5:1 contrast, the muted pill about 4.04:1, and the mobile toast overlays the
  comment composer for its 5 second lifetime.
- The arm64 image is build-proven only; running it emulated on x64 crashes inside
  Node 26 type stripping with `ERR_INTERNAL_ASSERTION`, so native arm64 is the
  runtime proof still outstanding.
- CI is not a required status check and `main` takes direct pushes, so deploy
  enforcement depends on `LAS-185` declaring `needs: verify` or on branch
  protection.
- The compose stack's default 80/443 and 55432 binds must be free, and a local
  browser must trust Caddy's extracted root CA. `docker compose -f
  deploy/docker-compose.yml down -v` deletes the Postgres and Caddy volumes and
  must never run on the server.
- `npm run acceptance` inherits `process.env` and the spawned server loads
  `.env`, so an operator with `COOKIE_SECURE=1` exported makes the plain-HTTP
  legs issue `Secure` cookies.
- `npm run smoke:container` runs against the local `curved` database and applies
  any pending migrations before the in-image command checks `already up to date`.
- `LAS-183` live acceptance is operator-executed: this environment has no OCI
  tenancy, reserved IPv4, or A1 instance, so the console steps, external port
  scan, key-only SSH proof, and 150 GB layout were exercised through the stub
  gate, not on a real host. `deploy/provisioning.md` section 10 is the operator
  evidence record.
- `npm run smoke:provision` pulls `ubuntu:24.04` when absent and stubs package
  installation, Docker, sshd, mount, and the network; the real apt and Docker
  path is live-only.
- `LAS-184`'s reboot and missing-mount behavior is proven by the managed
  configuration and the stub gate, not by a reboot of a real OCI instance; the
  operator proof is `deploy/provisioning.md` section 9.4.
- The `/var/lib/docker` migration is a `cp -a` copy, so it needs free space for
  a second copy on the data volume and leaves the old tree on the 50 GB boot
  volume until an operator removes it after `verify-host` passes.
- The first bootstrap that changes `daemon.json` recreates the Compose
  containers, which is a brief stack restart on an existing host.

## Open questions

- None blocking. MCP transport is settled on stdio with the v2 SDK, no v1
  fallback. Relation cycles stay permitted by design. The hub's idle LISTEN
  client is accepted behavior rather than a defect.

## Next best step

`LAS-185` (release script and SSH deploy job) is next. It must declare
`needs: verify`, never run `down -v` on the server, and account for the Docker
data root now living at `/srv/curved/docker`. `LAS-186` (public ACME, HSTS,
webhook delivery) and `LAS-187` (backups) follow. Run
`npm run smoke:provision` after any change to the host scripts.

## Tracker

- Linear workspace last-known-good (`LAS`), project Curved (`P-LAS-8`).
- Spec `LAS-140` with 15 sub-issues `LAS-141` through `LAS-155`, all Done.
- Refactor `LAS-167` with `LAS-168` through `LAS-176`, all Done.
- Infra and deploy: `LAS-179` through `LAS-184` Done; `LAS-177` (template
  audit) and `LAS-185` open.

## Session log

One line per session: earlier verification evidence and the full acceptance
matrices live in git history and the Linear comments. Sessions 001 to 013 ran on
2026-11-10, 014 to 018 on 2026-11-16, 019 to 030 on 2026-11-17, and 031 to 036
on 2026-11-18.

| Session | Work item | Outcome |
|---|---|---|
| 001 | Agent harness | `AGENTS.md`, `MEMORY.md`, `init.sh`, `clean-state.sh`, codegraph entry. |
| 002 | Spec | Linear project Curved (`P-LAS-8`) and spec `LAS-140` with the agreed seams. |
| 003 | Breakdown | 15 tickets `LAS-141`..`LAS-155` with native `blockedBy` edges. |
| 004 | Version control | git repo on `main`, public GitHub remote, initial commit. |
| 005 | `LAS-141` | toolchain, compose Postgres, advisory-locked migrations, projects CLI, test harness. |
| 006 | `LAS-142` | issues, atomic per-project keys, append-only events. |
| 007 | `LAS-143` | comments and the timeline read path. |
| 008 | `LAS-144` | status machine, actor matrix, `issue move`. |
| 009 | `LAS-145` | agents, hashed tokens, one-active-claim fence, ready/claim/review/release. |
| 010 | `LAS-146` | block and human unblock, blocked issues out of `ready`. |
| 011 | `LAS-147` | MCP over stdio with the eight tools. |
| 012 | `LAS-148` | HTTP API, auth boundary, SPA fallback. |
| 013 | `LAS-149` | labels, relations, dependency-aware ready. |
| 014 | SPA prototype | Vite/React board, queue, detail, palette on the warm palette. |
| 015 | Modal | issue detail as a centered modal on the shared `Modal` shell. |
| 016 | `LAS-150` | SSE stream, event hub, SPA realtime replacing the poll. |
| 017 | `LAS-151` | GitHub webhook and the `git-branch` helper. |
| 018 | `LAS-152` | route-driven new-issue dialog, mobile status bar, 900 px board. |
| 019 | `LAS-168` | `ARCH.md` contract and the template startup step. |
| 020 | `LAS-169` | pure `src/domain/`, old contract and error modules deleted. |
| 021 | `LAS-170` | ports, the projects resource, the token codec. |
| 022 | `LAS-171` | issue lifecycle and read model on ports. |
| 023 | `LAS-172` | agents, queue, blocking, comments on ports. |
| 024 | `LAS-173` | labels, relations, GitHub use case on ports; `src/services/` deleted. |
| 025 | `LAS-174` | inbound adapter rewire, composition roots, architecture gate. |
| 026 | `LAS-171` audit | ten criteria verified against `HEAD`, ticket closed, no code change. |
| 027 | `LAS-175` | web layering into `domain`, `application`, `adapters`, `ui`. |
| 028 | `LAS-176` | completion gate, boundary and entry-point audit, handoff. |
| 029 | `LAS-155` | end-to-end acceptance gate with the CDP browser leg. |
| 030 | `LAS-153`, `151`, `154` | criteria verified, palette key span and list scrolling fixed. |
| 031 | `LAS-179` | opt-in `COOKIE_SECURE` on the session cookie. |
| 032 | `LAS-180` | production image and the container smoke gate. |
| 033 | `LAS-181` | CI verification gate on push to `main`. |
| 034 | `LAS-182` | production compose stack with Caddy TLS and its smoke gate. |
| 035 | `LAS-183` | OCI provisioning runbook, idempotent host bootstrap, access-boundary verifier, and the stub provisioning gate. |
| 036 | `LAS-184` | Docker data root on the data volume with migration, systemd mount gate, log rotation, prune timer, verifier checks, reboot runbook, and the extended provisioning gate. |
