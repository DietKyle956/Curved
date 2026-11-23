# MEMORY.md

- **Last updated:** 2026-11-23
- **Project:** curved
- **Phase:** product and infrastructure implemented through `LAS-190` (first-run
  seed and public product acceptance, on top of the `LAS-189` agent tunnel and
  deployed-commit parity, the `LAS-188` free-tier keepalive
  and rebuild runbook), the project entity is live (migration `0007`:
  summary, description, six-value status, nullable priority and dates, archive,
  and per-status progress across the CLI, HTTP API, and SPA), and passkey login
  is live (migration `0006`, opaque server-side sessions, passkey routes, and
  the sign-in and management UI). Passkeys are now scoped to the relying party
  ID (migration `0008`): credentials from a previous domain stay inert, the
  sign-in page disables the passkey button and explains the move when only
  stale rows exist, and the operator adds a new passkey with the UI token then
  deletes the old row. `LAS-188` is Done: the rebuild drill ran on
  2026-11-23 on a fresh instance, restored from a dump, and cut over to the
  reserved `129.213.209.162` behind `https://curv3d.duckdns.org`; the old
  sslip instance is stopped as rollback. `LAS-189` is Done: the agent tunnel
  and deployed-commit parity are live (`deploy/agent-tunnel.sh`,
  `deploy/agent-preflight.sh`, and the 16-check `npm run smoke:agent`).
  `LAS-190` is Done: the empty UI-token refusal is covered at the real
  entrypoint, first-run setup created a project through the SPA against a
  throwaway database on the deployed Postgres, and a 390x844 public HTTPS run
  passed 77 checks across the full human surface and human plus agent SSE.
  Next unbuilt work is `LAS-177` (template audit).

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
  `npm run smoke:provision`, `npm run smoke:release`,
  `npm run smoke:backup`, `npm run smoke:webhook`,
  `npm run smoke:agent`, and
  `.github/workflows/verify.yml` on every push to `main` and manual dispatch,
  where the main-only `deploy` job runs after `verify`.
- Baseline: 228 tests pass (222 behavior, 6 architecture),
  `architecture: ok (84 files)`, web build green; `npm run acceptance` passes
  (197 checks, including the project CLI show/edit/archive/restore and HTTP
  detail/`PATCH`/archive legs, the browser passkey registration and passkey
  sign-in lines, and the sign-in-only `browser-signin` leg that seeds a stale
  passkey row and asserts the disabled button and explanation),
  `npm run smoke:release` 22 assertions,
  `npm run smoke:backup` 19, `npm run smoke:provision` 52,
  `npm run smoke:webhook` 9, and `npm run smoke:compose` includes the real
  backup, Postgres drill, and Caddy restore legs. Public product acceptance on
  the deployed stack passed 77 checks on 2026-11-23 (section 20).
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
  name 1..200, `next_number`; migration `0007` adds a trimmed `summary` of at
  most 255, a `description` of at most 20000, a six-value `status` (`backlog`,
  `planned`, `in_progress`, `paused`, `completed`, `canceled`; default
  `planned`), a nullable 1..4 `priority`, nullable `start_date` and
  `target_date`, `archived_at`, and `updated_at`, with four check constraints
  and a backfill to `in_progress` when the project already owned issues and
  `planned` otherwise; there is no project delete, so archive is terminal);
  `issues` (per-project `number`, unique key
  `^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$`, trimmed title 1..500, description, status,
  priority 1..4, optional parent, `blocked_reason`, `claimed_by`, timestamps);
  append-only `issue_events` (UPDATE and DELETE rejected with SQLSTATE 23001);
  `agents` (unique trimmed name 1..100, unique lowercase SHA-256 `token_hash`);
  migration `0004` adds `labels`, `issue_labels`, `issue_relations`; migration
  `0005` adds the `pg_notify` triggers; migration `0006` adds
  `passkey_credentials`, `auth_sessions`, and `webauthn_challenges`; migration
  `0008` adds a nullable `passkey_credentials.rp_id` with a format check,
  leaving pre-migration rows NULL and inert.
  `issues_one_active_claim_per_agent` is
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
- CLI (`node src/composition/cli.ts`):
  `project add|list|show|edit|archive|restore` (human actor, `--json` prints
  progress, `--priority`/`--start`/`--target` accept `none` to clear),
  `issue add|list|show|comment|move|block|unblock`, `agent add`,
  `ready [PROJECT] [--human]`, `claim`, `review`, `release`,
  `git-branch <KEY> [--json]`, `migrate`. Agent commands read
  `CURVED_AGENT_TOKEN` and never fall back to the human actor; errors print
  `<code>: <message>` and exit 1.
- HTTP (`npm start`, `PORT` default 4747): requires `CURVED_UI_TOKEN`; humans
  authenticate by UI bearer or the `curved_session` cookie, agents by `crv_`
  bearer. The cookie holds a 32-character base64url nonce (192 bits) and only
  its SHA-256 is stored in `auth_sessions`; the row expires after 30 days
  (`SESSION_MAX_AGE_SECONDS=2592000`), both token and passkey logins create one,
  and `DELETE /api/session` deletes the row so logout revokes it. The old
  deterministic `sha256(UI_TOKEN)` cookie is gone, so existing cookies require a
  new sign-in. Routes cover `/api/me`, `/api/session`, the passkey endpoints
  (see below), projects (list with `includeArchived`, create, show, human-only
  `PATCH`), issues (list with `project` and `status` filters,
  create, show, human-only `PATCH`), transition, comments, labels, relations,
  block, unblock, release, `/api/ready`, `/api/claims/next`, cookie-only
  `/api/events`, and `/webhooks/github`. Passkey routes: `GET
  /api/passkeys/available` (no auth, `{ available, otherDomain }`,
  `cache-control: no-store`), `GET /api/passkeys`, `POST
  /api/passkeys/options`, `POST /api/passkeys` (201 `{ passkey }`), and `DELETE
  /api/passkeys/:id` (204) are human-only, while `POST
  /api/session/passkey/options` and `POST /api/session/passkey` are
  unauthenticated login options and completion that returns the actor plus a
  session cookie. Human-only routes accept either the
  UI bearer or the session cookie; one implicit human identity owns many
  passkeys, with no users table and no actor/timeline change, and the token
  bearer stays valid for deploy, health, CLI, MCP, and acceptance. Errors are
  `{ error: { code, message } }` with 400, 401, 403, 404, 409, and 500 mapping.
  Non-`/api` paths serve `web/dist` with no-cache documents and immutable
  `/assets/*`, or a 503 naming the build.
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
  palette, toasts. Projects have a `/projects` page, a `/p/<KEY>/overview` page
  with status chip, dates, and per-status progress, and a create/edit/archive
  dialog; the sidebar carries Projects and Overview rows and the mobile nav is
  five cells at 390 px (78 px each). The sign-in screen leads with a primary
  "Sign in with passkey" button (Face ID, Touch ID, or a security key) above a
  "Use a UI token" divider holding the token form. Any signed-in session opens a
  Passkeys dialog from the topbar, the sidebar footer, or the palette action "Manage
  passkeys", where a passkey can be added with a nickname or removed. Fixed
  warm near-black palette, Instrument Sans + JetBrains Mono, self-hosted fonts,
  no light mode, `lg` breakpoint overridden to 900 px.
- Config: `DATABASE_URL`, `TEST_DATABASE_URL`, `CURVED_UI_TOKEN`,
  `GITHUB_WEBHOOK_SECRET`, `PORT` (4747), `CURVED_DOMAIN`,
  `CURVED_WEBAUTHN_ORIGINS` (comma-separated origins), `CURVED_WEBAUTHN_RP_ID`,
  `CURVED_HSTS_MAX_AGE` (Caddy sends `Strict-Transport-Security:
  max-age=<value>` only when non-empty; localhost leaves it empty so HSTS is
  never pinned), and `COOKIE_SECURE` (opt-in `Secure` on the session cookie;
  unset, empty, `0`, or `false` is off, `1` or `true` is on, anything else
  throws naming the variable). WebAuthn origins default to
  `https://$CURVED_DOMAIN` when `CURVED_DOMAIN` is set, else
  `http://localhost:4747` and `http://localhost:5173`; the RP ID defaults to
  the hostname of the first origin. Explicit origins must be bare http/https
  origins and must match the RP ID or be subdomains of it. Compose passes
  `CURVED_DOMAIN`, so an existing `deploy/.env` needs no new key.
- Tests: isolated database from `TEST_DATABASE_URL` (name must start with
  `curved_test`), created and migrated by `test/helpers/db.ts` and truncated
  between tests; the development database is never touched.
  `test/passkeys.test.ts` covers availability without auth, listing without
  verification material,
  registration and login option contents, single-use challenges, unknown
  credentials, and nickname validation; the HTTP and SSE session suites exercise
  the opaque cookie rows.
- Acceptance (`npm run acceptance`): CLI lifecycle, the eight-tool MCP
  handshake, HTTP plus SSE, a signed webhook with replay, a 24-issue palette
  seed, and a Chromium/CDP browser leg at 390x844, all against one throwaway
  `curved_acceptance_<pid>_<epoch>` database that is dropped afterward. It fails
  if a per-table digest of the default `curved` database changes. The browser
  leg registers a passkey and signs in with it through Chromium's CDP virtual
  authenticator, printing `PASS browser: passkey registered ...` and `PASS
  browser: passkey sign-in reached the board ...`; the driver enables focus
  emulation because headless tabs otherwise reject WebAuthn with
  `NotAllowedError`. Flags `--skip-browser` and `--keep`.
- Deploy: root `Dockerfile` (multi-stage `node:26-slim`, build then prune,
  runtime as `USER node`) and `deploy/` (compose project `curved-prod`: `db` on
  `127.0.0.1:55432`, `app` running migrations then the server with no host port,
  `caddy` publishing 80/443 TCP+UDP). An empty `ACME_EMAIL` selects Caddy's
  internal CA; a set email switches to ACME. Host ports and the image tag are
  compose variables. Agents reach the deployed Postgres through
  `deploy/agent-tunnel.sh`, which forwards `55433` to `127.0.0.1:55432`.
  `deploy/release.sh` is the only release
  path: database `up -d --wait --wait-timeout 300`, build `curved:<short-sha>`,
  the one-shot `run --rm --no-deps -T app node src/composition/migrate.ts`,
  app `up -d --no-deps --wait --wait-timeout 600`, caddy `up -d --no-deps`,
  then an authenticated probe of `GET https://$CURVED_DOMAIN/api/projects`
  with the UI bearer (Caddy's internal root CA extracted through
  `compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt` when
  `ACME_EMAIL` is empty; with a public email it requires a
  `Strict-Transport-Security` header whose max-age matches
  `CURVED_HSTS_MAX_AGE`), and only then `docker tag curved:<short-sha>
  curved:latest`, an atomic write to `/srv/curved/release-state`, and
  `release: ok <short>`. A failed migration exits before any app or caddy
  recreate, latest tag, or state write and states the previous app is still
  serving. An absent state file is a first release, which skips the public probe
  unless `--require-public-probe`; later releases require it and a probe failure
  is red with latest and state untouched. `--skip-public-probe` skips with a
  warning and is a usage error together with `--require-public-probe`.
  `./deploy/release.sh rollback <tag>` normalizes `curved:<tag>`, requires
  `docker image inspect`, runs no migrations, recreates app then caddy, applies
  the same probe policy, updates state, and warns that a non-backward-compatible
  migration requires a database restore instead of an image rollback. The
  release path never runs `down` or `down -v`.
- Agent access (`LAS-189`): `deploy/agent-tunnel.sh` forwards `55433` to
  `127.0.0.1:55432` with strict SSH options and refuses the `55432` local port
  so the development listener is never displaced; `deploy/agent-preflight.sh`
  compares the checkout `HEAD` to `/srv/curved/release-state` and takes
  `--require-tunnel` to insist the tunnel is up before an agent runs. Both are
  exercised by `npm run smoke:agent` (16 checks). `deploy/provisioning.md`
  section 19 and `README.md` document the tunnel, the preflight, the MCP stdio
  entry, and the gates. The one-time agent token handover lives at
  `/home/dietkyle/.curved-las189-agent.token` (mode 600, outside the repo) and
  is never printed or committed.
- Public edge: the live host serves `https://curv3d.duckdns.org` from a
  DNS-only DuckDNS A record at the reserved public IP `129.213.209.162`, with a
  Let's Encrypt certificate (issuer `YE2`, subject `CN=curv3d.duckdns.org`,
  valid to 2027-02-21), `CURVED_DOMAIN=curv3d.duckdns.org`,
  `ACME_EMAIL=admin@sslip.io`, `CURVED_HSTS_MAX_AGE=31536000`, and
  `COOKIE_SECURE=1`. Caddy redirects port 80 with `308`, sends
  `Strict-Transport-Security: max-age=31536000`, compresses with zstd/gzip
  except `/api/events`, and proxies `/api/events` with `flush_interval -1`; the
  log records `certificate obtained successfully` from
  `acme-v02.api.letsencrypt.org-directory` over tls-alpn-01. The public edge
  serves the SPA, authenticated API, and SSE (`ready`, then `issues_changed`)
  over verified TLS; the unauthenticated `/api/projects` stays 401.
  `verify-host` exits 0 with 27 PASS lines, including `tls-certificate`,
  `http-redirect`, `hsts`, `compression`, and `caddy-issuance`. The release
  probe requires HSTS under ACME and matches `CURVED_HSTS_MAX_AGE`; LAS-188's
  manual dispatch run 45191364607 passed Verify and Deploy, and the live
  release printed `release: public probe ok` and `release: ok d002ccd`.
  LAS-186's original `158.101.127.247.sslip.io` address was an ephemeral public
  IP, not reserved; it is retired. The live webhook is `715784553` at
  `https://curv3d.duckdns.org/webhooks/github` (old `714067501` deleted); a
  signed ping returns 200, the unsigned request 401, and the GitHub ping
  delivery returned 200.
- Backups (`LAS-187`): `deploy/backup.sh` writes private sets under
  `/srv/curved/backups` (mode 0700, files 0600) at
  `<kind>/<UTC 20261119T031700Z>/` with `postgres.dump` (`pg_dump -Fc -Z 9
  --no-owner --no-privileges` from the `db` container), `caddy-data.tar.gz`
  and `caddy-config.tar.gz` (from `tar -C /data|/config -czf -` in the `caddy`
  container), a fixed-key `manifest.txt`, and `SHA256SUMS`. Staging is
  published atomically, `latest` is a relative symlink, `flock` on
  `.backup.lock` blocks overlap, and retention keeps the newest 7 sets per
  kind (`--keep`, `--no-prune`). `nightly` requires Caddy; `pre-deploy` records
  `caddy=skipped` when Caddy is absent. `deploy/restore.sh` verifies
  `SHA256SUMS`, requires `--yes`, stops the app for a restore into
  `POSTGRES_DB` and leaves it stopped, creates and restores a `--database`
  drill while the app keeps running, and restores Caddy by stopping it,
  extracting both archives through one-shot containers, and starting it again.
  `deploy/release.sh` records a `pre-deploy` set after the database is up and
  before the build or any migration; a backup failure aborts the release with
  no build, migration, recreate, tag, or state write. Bootstrap creates the
  backup directory and installs `curved-backup.service` plus
  `curved-backup.timer` (daily 03:17, 20 minute jitter,
  `Persistent=true`, as `deploy` with `CURVED_BACKUP_DIR`), and takes one
  initial nightly set. `verify-host` adds `backup-dir` (0700 deploy),
  `backup-timer` (units enabled and active), `backup-freshness` (newest nightly
  set at most 26 hours old with a non-empty dump), and `backup-integrity`
  (`sha256sum -c` over `SHA256SUMS`), taking the live check count from 22 to
  26. Live on 2026-11-19: deploy run 44578798179 passed `verify` and the SSH
  `deploy` job; the release wrote pre-deploy set `20261119T173637Z`
  (`tag=curved:ec6666d`, `caddy=archived`), the bootstrap re-run installed the
  timer, nightly set `20261119T173741Z` published and verified, `verify-host`
  exits 0 with 26 PASS, and a drill restored 1 project and 3 issues (`LIVE-1`
  at `done`) into `curved_backup_drill` while the app stayed 200; the drill
  database was dropped.
- Keepalive (`LAS-188`): `deploy/keepalive.sh` burns one core at `nice 19` for
  600 seconds by default (`CURVED_KEEPALIVE_SECONDS`, `CURVED_KEEPALIVE_CPUS`,
  `taskset` on core 0 when present, timeout exits 124/143 count as success);
  bootstrap installs it as `/usr/local/bin/curved-keepalive` (root:root 0755)
  and writes `curved-keepalive.service` (`Type=oneshot`, `Nice=19`,
  `IOSchedulingClass=idle`, `TimeoutStartSec=700`) plus
  `curved-keepalive.timer` (`OnCalendar=hourly`, `AccuracySec=1min`), enabling
  the timer. `verify-host` adds `keepalive-timer` (units present, script
  executable, timer enabled and active) for 27 checks; `smoke:provision`
  asserts the installed script, units, timer state, idempotent reinstall, and
  a disabled-timer negative for 52 PASS. `deploy/provisioning.md` section 18
  documents the keepalive and the rebuild-after-reclamation runbook (new A1,
  volume attached unformatted or a new volume plus `restore.sh postgres` from
  the newest off-host dump, reserved IPv4 reassigned, known-hosts refreshed,
  bootstrap, `release.sh`, 27 PASS). Live on 2026-11-19: bootstrap
  `--no-stack` installed the units, `verify-host` printed 27 PASS and 0 FAIL,
  and 12 `/proc/stat` samples during a 62 second run read 53-56% total CPU,
  p95 55%, average 54.1%, with the timer's next elapse at 19:00 UTC. The
  console reclamation step is operator-executed.
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
- Live host: OCI instance `curved-rebuild`, reserved public `129.213.209.162`,
  us-ashburn-1, AD-1, Ubuntu 24.04 aarch64, 2 OCPU / 12 GB, 50 GB boot plus a
  fresh 100 GB `curved-data-rebuild` data volume, root compartment, private IP
  `10.0.0.23/24`. Access is the operator's OCI CLI profile `~/.oci/config`
  (`~/bin/oci`) and the `ubuntu` key injected at launch (`~/.ssh/id_ed25519`,
  comment `timeledger-deploy`); bootstrap installed the same key for `deploy`.
  Deploy secrets target the new host: `DEPLOY_HOST=129.213.209.162`, fresh
  `DEPLOY_KNOWN_HOSTS`, and a rotated `DEPLOY_SSH_KEY`. The original `curved`
  instance is STOPPED with its boot volume and original `curved-data` volume
  kept as rollback; its ephemeral `158.101.127.247` address and `sslip.io` URL
  are retired. `verify-host` exits 0 with 27 PASS lines including the edge,
  backup, and keepalive checks; the SPA, authenticated API, SSE, and webhook
  answer over `https://curv3d.duckdns.org` and unauthenticated `/api/projects`
  is 401.
- CI: `.github/workflows/verify.yml`, one global concurrency group `verify` with
  `cancel-in-progress: false`, a Postgres 18 service on 55432, then `npm ci`,
  `typecheck`, `check:arch`, `test`, and `build:web`. The `deploy` job declares
  `needs: verify` and `if: github.ref == 'refs/heads/main'`, so it runs on a push
  to main and on manual dispatch only. It validates `DEPLOY_SSH_KEY`,
  `DEPLOY_KNOWN_HOSTS`, and `DEPLOY_HOST`, writes the key and known_hosts under
  `$RUNNER_TEMP` mode 600, and SSHes as `deploy@$DEPLOY_HOST` (BatchMode,
  IdentitiesOnly, StrictHostKeyChecking=yes against the pinned file) to run
  `cd /srv/curved/checkout && git fetch --prune origin main && git reset --hard origin/main && ./deploy/release.sh`;
  a manual dispatch exposes `skip_public_probe`, which appends
  `--skip-public-probe`. The deploy key is a dedicated Ed25519 pair whose private
  half exists only as the `DEPLOY_SSH_KEY` secret, and the `deploy` account is
  root-equivalent through the docker group. Live on 2026-11-19: push run
  44538665002 (verify 1m10s, deploy 40s) deployed fcfafd4 with the first-release
  probe skip logged, and manual dispatch run 44539044406 (verify 58s, deploy
  16s) re-released fcfafd4 with `release: public probe ok`. A live rollback to
  the pre-release image retagged `curved:480a069` recreated a healthy app,
  probed, and recorded state, then a forward release rebuilt and returned to
  `curved:fcfafd4` and recorded
  `tag=curved:fcfafd4 sha=fcfafd4 at=2026-11-19T14:02:06Z`; `curved:latest` and
  `curved:fcfafd4` share image c37487aa4a13.
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
  default while production compose sets `COOKIE_SECURE=1`. The value is an
  opaque 32-character base64url nonce whose SHA-256 is the `auth_sessions` row
  key; the token bearer stays a separate, non-revocable credential.
- The production compose `app` runs the idempotent migration command before the
  server so one `up` reaches a healthy schema; the release script also runs the
  migration command separately, before it recreates the app. Local TLS uses
  Caddy's internal CA; ACME issuance is production-only.
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
- Release automation (`LAS-185`) is one `deploy` job in the existing workflow,
  not a second pipeline: it declares `needs: verify` and the main-ref `if`, pins
  the host key through `DEPLOY_KNOWN_HOSTS` with StrictHostKeyChecking=yes, and
  uses a dedicated Ed25519 key whose private half lives only in the repository
  secret. The host-side release order is fixed: database, build, one-shot
  migration, app, caddy, authenticated probe. The migration runs before any
  app or caddy recreate, so a bad migration exits while the previous app is
  still serving and no latest tag or state write happens. First-release
  detection is the absent `/srv/curved/release-state`, which skips the public
  probe unless `--require-public-probe`; later releases require it, a probe
  failure is red, and `--skip-public-probe` with `--require-public-probe` is a
  usage error. The probe uses the UI bearer and, with an empty `ACME_EMAIL`,
  Caddy's internal root CA; with a public email it verifies the public chain and
  requires HSTS whose max-age matches `CURVED_HSTS_MAX_AGE`. `curved:latest` is
  tagged only after a passing probe, and the state write is atomic, so a red
  release leaves the previous image and state intact. Rollback retags an
  existing image, runs no migrations, recreates app then caddy, applies the same
  probe policy, and updates state; it
  cannot reverse a schema, so a non-backward-compatible migration needs a
  database restore. The release path never runs `down` or `down -v`. The
  workflow stays one concurrency group: a pending run is replaced by a newer
  queued run, but an in-flight run is never cancelled.
- Public edge (`LAS-186`) makes HSTS conditional on `CURVED_HSTS_MAX_AGE`, so a
  localhost stack never pins it; `/api/events` is excluded from compression and
  proxied with `flush_interval -1`. The IP-only host uses sslip.io wildcard DNS
  for its public name; switching to an owned domain is a `CURVED_DOMAIN` and
  `ACME_EMAIL` edit plus a Caddy recreate. `deploy/webhook.sh` matches hooks by
  `config.url` and always PATCHes so the current secret is reapplied.
- Backups (`LAS-187`) are logical Postgres dumps plus volume archives, not a
  copy of the live `pgdata`: `pg_dump` is consistent while the app runs and
  restores through `pg_restore --clean`, while hot-copying `pgdata` is not
  crash-safe. The Caddy archives are taken from the running container because
  cert state, the ACME account, and the internal CA all live in the two
  volumes. A set is staged, checksummed, and renamed into place, and retention
  only runs after a successful publish, so a failed run never disturbs the
  previous set or `latest`. The pre-deploy dump is mandatory before the build
  and migration, which makes it the pre-migration recovery point; rollback
  takes no backup because it applies no schema. Restore into `POSTGRES_DB`
  stops the app and leaves it stopped so no request can write into a
  half-restored schema; a `--database` drill never stops the app. Backups share
  the data volume with the database they protect, so they cover logical
  corruption and operator error but not host or block-volume loss; an off-host
  copy remains an operator step.
- Keepalive (`LAS-188`) is a CPU burner, not an API pinger: Oracle's idle test
  looks at the CPU 95th percentile, network, and memory over a rolling window,
  and one core of two for 16.7% of samples lifts the p95 while the average
  stays low. The burn runs at `nice 19` and idle I/O so the request path keeps
  priority, `taskset` pins a single core, and the unit caps a run at
  `TimeoutStartSec=700` so a stuck loop cannot hold the timer. Verifying a
  schedule is structural (units, installed script, enabled and active timer);
  the CPU effect is measured at the host with `/proc/stat`, not asserted by a
  flaky timing test. The rebuild runbook treats the data volume as the durable
  object: attach it unformatted and let bootstrap recreate the OS-side state,
  or, when the volume is gone, restore the newest off-host dump before the
  first release, and never run `docker compose down -v`.

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
- The keepalive occupies one of two vCPUs for ten minutes every hour; the app
  stays responsive because the burn is at `nice 19`, but a CPU-heavy request
  in that window can slow down. A host that misses runs or is stopped for a
  long quiet period can still be classified idle, so the rebuild runbook is
  the recovery path, not a guarantee.
- `keepalive-timer` checks the units and the enabled/active timer, not a recent
  run; the first trigger lands at the next top of the hour. A run that exits
  non-zero is only visible in `journalctl -u curved-keepalive.service`.
- The LAS-188 drill exercised the fresh-instance rebuild live on 2026-11-23
  (see the session log and `deploy/provisioning.md` 18.3). The smoke gate still
  stubs the host, and future OCI console steps remain operator-executed; the
  original live address was ephemeral, so the drill corrected the runbook to
  use a reserved IP and the DuckDNS name.
- Palette traits recorded, not changed: the active palette status label is about
  3.5:1 contrast, the muted pill about 4.04:1, and the mobile toast overlays the
  comment composer for its 5 second lifetime.
- arm64 is the live architecture: the image builds and runs natively on the
  aarch64 host and served the live releases. Running the arm64 image emulated on
  x64 still crashes inside Node 26 type stripping with
  `ERR_INTERNAL_ASSERTION`.
- CI is not a required status check and `main` takes direct pushes, so an
  unverified commit can land on main. The deploy job's `needs: verify` keeps
  that commit off the host, but branch protection is still the only way to keep
  main green before a deploy attempt.
- The `deploy` account is root-equivalent through the docker group, so the
  `DEPLOY_SSH_KEY` secret it authenticates with is effectively host root.
  Rotate the Ed25519 pair and remove the old public half from
  `/home/deploy/.ssh/authorized_keys` if the secret leaks.
- The first-release rule skips the public probe whenever the state file is
  absent, so a first release proves only that the host-local HTTPS path answers;
  only a later release exercises the required-probe path.
- Rollback replays an image, not a schema: a non-backward-compatible migration
  needs `deploy/restore.sh postgres /srv/curved/backups/pre-deploy/latest
  --yes` followed by `deploy/release.sh rollback <tag>`. The pre-deploy dump is
  taken before every migration, but it shares the data volume with the
  database, so a host or volume loss still needs an off-host copy that the
  automation does not make.
- The Caddy archives are read from the running container, so a file being
  rewritten during the tar can be captured mid-write; Caddy's state files are
  small and replaced atomically in normal operation, and the set still carries
  the last good certificate and account state.
- A production Postgres restore uses `--clean --if-exists` while the app is
  stopped; a second client holding locks on an object can still make
  `pg_restore` fail, in which case the dump and the stopped app remain and the
  restore is retried after that client disconnects.
- `backup-freshness` allows 26 hours, so a host booted with `Persistent=true`
  after a missed 03:17 run is green once the catch-up run finishes; a host
  whose initial backup failed or whose timer is disabled is red until a
  manual `./deploy/backup.sh nightly` succeeds.
- The backup timer and the release script can overlap on the `flock`; a timer
  run that loses the lock fails that run but retries the next day, so the
  operator sees it in `journalctl -u curved-backup.service`.
- The public name is DuckDNS `curv3d.duckdns.org`, a DNS-only A record at the
  reserved IP; DuckDNS is still a shared third-party service, so if it stops
  resolving or is blocked by a resolver, ACME renewal and webhook delivery
  fail. An owned DNS-only name removes that dependency. The old
  `158.101.127.247.sslip.io` name is retired.
- Let's Encrypt rate limits apply per registered domain, so repeated failed
  issuances can pause new certificates. HSTS is a one-year pin: after a TLS
  break a browser refuses the site until the edge serves `max-age=0` over a
  valid certificate or the browser HSTS state is cleared.
- Caddy renews the certificate automatically near expiry; only the initial
  issuance has been observed live, not a renewal.
- The webhook test PRs merged empty commits into `main`; the deploy job reset
  the host checkout to the newer `main` and released `c711540` during the run.
- The compose stack's default 80/443 and 55432 binds must be free, and a local
  browser must trust Caddy's extracted root CA. `docker compose -f
  deploy/docker-compose.yml down -v` deletes the Postgres and Caddy volumes and
  must never run on the server.
- `npm run acceptance` inherits `process.env` and the spawned server loads
  `.env`, so an operator with `COOKIE_SECURE=1` exported makes the plain-HTTP
  legs issue `Secure` cookies.
- `npm run smoke:container` runs against the local `curved` database and applies
  any pending migrations before the in-image command checks `already up to date`.
- `LAS-183` and `LAS-184` live acceptance ran on 2026-11-18 on the live host
  recorded under Current verified state, including the external port scan,
  key-only SSH, 150 GB layout, reboot, and post-reboot verifier. The
  missing-volume boot path (`RequiresMountsFor` plus
  `ConditionPathIsMountPoint`) is config-proven and stub-tested, not
  live-tested.
- `npm run smoke:provision` pulls `ubuntu:24.04` when absent and stubs package
  installation, Docker, sshd, mount, and the network; the real apt and Docker
  path is live-only.
- OCI device names are not stable: after the first reboot the 100 GB data
  volume enumerated as `/dev/sda` and the 50 GB boot volume as `/dev/sdb`. The
  fstab UUID mount and the mount-based verifier handle it; never reuse the
  bootstrap `/dev/sdb` path after a reboot.
- The fresh OCI Ubuntu image can run `rpcbind` on 111/tcp and 111/udp and can
  ship an iptables INPUT that only allows 22, so 80/443 time out even with the
  security list correct. Bootstrap now removes `rpcbind` when the image
  provides it; the iptables ACCEPT rules remain a manual step, documented with
  the checks in `deploy/provisioning.md` section 15. The LAS-188 host verified
  27 PASS after the rpcbind removal.
- The `/var/lib/docker` migration is a `cp -a` copy, so it needs free space for
  a second copy on the data volume and leaves the old tree on the 50 GB boot
  volume until an operator removes it after `verify-host` passes.
- The first bootstrap that changes `daemon.json` recreates the Compose
  containers, which is a brief stack restart on an existing host.
- The deploy key is root-equivalent and the `LAS-189` proof agent token exists
  only in a mode-600 home file (`/home/dietkyle/.curved-las189-agent.token`);
  do not commit either. The live proof left archived `PRFTEINIO`/`OTHTEINIO`
  projects and their append-only issues on the production database as evidence,
  and those rows cannot be deleted.

## Open questions

- None blocking. MCP transport is settled on stdio with the v2 SDK, no v1
  fallback. Relation cycles stay permitted by design. The hub's idle LISTEN
  client is accepted behavior rather than a defect.

## Next best step

`LAS-190` (first-run seed and public product acceptance) is Done. On
2026-11-23 at deployed `57ced3d`, the image refused to start with an empty
`CURVED_UI_TOKEN` (`exit=1`, stderr naming the variable), and
`test/server-entry.test.ts` now pins that real entrypoint. First-run setup
created `FIRST` through the SPA against `curved_las190_firstrun` on the
deployed Postgres (the project row read back with 0 issues; the throwaway
database, container, and forward were removed). The 390x844 public HTTPS run
at `https://curv3d.duckdns.org` passed 77 checks: sign-in, session persistence
across navigation, board blocked badge and label chips, ready queue stats and
rows, detail timeline and comment, labels, relation on both API sides, human
unblock dropping the queue blocked count to 0, palette, and human plus agent
SSE without a reload. Proof project `LAS190` was released and archived, leaving
its issues and timeline as evidence; `deploy/provisioning.md` section 20 is the
runbook. Prior, `LAS-189` (agent tunnel and deployed-commit parity) is Done. The live proof on
2026-11-23 against `https://curv3d.duckdns.org` (`129.213.209.162`) found local
`HEAD` and `/srv/curved/release-state` both at `de5c863`, ran
`deploy/agent-preflight.sh --require-tunnel` green, and kept `55432` as the
local development listener while `55433` carried the tunnel. An agent created
through the CLI in the app image received a one-time `crv_` token written to a
mode-600 home file, then the CLI created projects `PRFTEINIO`/`OTHTEINIO` and
issues `PRFTEINIO-1`/`2`/`3` and `OTHTEINIO-1` over the tunnel. A human HTTP
relation made `PRFTEINIO-2` blocked by `PRFTEINIO-1`; all eight MCP tools were
exercised; `list_ready` omitted the blocked issue; `claim_next` claimed
`PRFTEINIO-1`; a second claim filtered to `OTHTEINIO` failed `agent_busy`
naming `PRFTEINIO-1`, which proves the global claim fence. A human moved
`PRFTEINIO-1` to `done`, the formerly blocked `PRFTEINIO-2` became ready and was
claimed, and `mark_blocked` returned it to `todo` with a reason. Both projects
were archived and the relation unblocked; the issues remain as evidence.
`LAS-177` (template audit) is the next unbuilt work. A push to
`main` runs `verify`, then the main-only `deploy` job, which resets
`/srv/curved/checkout` and runs `./deploy/release.sh`; the release now takes a
pre-deploy backup before the build and migration, and the public probe requires
HSTS under ACME. The state file lives at `/srv/curved/release-state`, the
Docker data root at `/srv/curved/docker`, and backups at
`/srv/curved/backups` with the daily `curved-backup.timer`. Run
`npm run smoke:provision` after any change to the host scripts,
`npm run smoke:backup` after any change to the backup or restore scripts,
`npm run smoke:release` after any change to the release script,
`npm run smoke:webhook` after any change to the webhook script, and
`npm run smoke:agent` after any change to the agent tunnel, preflight, or smoke
script.

## Tracker

- Linear workspace last-known-good (`LAS`), project Curved (`P-LAS-8`).
  Verified against the Linear API on 2026-11-19.
- Spec `LAS-140` is still Todo (High) in Linear although its 15 sub-issues
  `LAS-141` through `LAS-155` are Done.
- Refactor `LAS-167` with `LAS-168` through `LAS-176`, all Done.
- Infra and deploy: `LAS-179` through `LAS-190` Done; parent `LAS-178` is
  Backlog. The live endpoint is `https://curv3d.duckdns.org` on reserved
  `129.213.209.162`; the old `curved` instance is stopped as rollback.
  `LAS-189` (agent tunnel and deployed-commit parity) and `LAS-190` (first-run
  seed and public product acceptance) are Done. `LAS-177` (template audit) is
  Todo (Medium).

## Session log

One line per session: earlier verification evidence and the full acceptance
matrices live in git history and the Linear comments. Sessions 001 to 013 ran on
2026-11-10, 014 to 018 on 2026-11-16, 019 to 030 on 2026-11-17, 031 to 036
on 2026-11-18, and 037 to 039 on 2026-11-19. Sessions 040 to 048 ran on
2026-11-23.

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
| 036 | `LAS-184` | Docker data root on the data volume with migration, systemd mount gate, log rotation, prune timer, verifier checks, reboot runbook, and the extended provisioning gate; live OCI bootstrap and reboot proof passed. |
| 037 | `LAS-185` | `deploy/release.sh` with the fixed release order, first-release probe rule, latest-after-probe tagging, atomic state, and rollback; main-only `deploy` job with pinned SSH and the `DEPLOY_*` secrets; `npm run smoke:release` gate; live push, manual dispatch, and rollback/forward proof; provisioning docs updated. |
| 038 | `LAS-186` | public Let's Encrypt TLS at `158.101.127.247.sslip.io`, HTTP 308, conditional HSTS, gzip/zstd except unbuffered SSE, edge verifier checks, HSTS-aware release probe, `deploy/webhook.sh` and its gate, live GitHub opened/reopened/merged PR flow plus replay/unknown/non-PR ignores, compose/provision/release/webhook smokes, docs and MEMORY. |
| 039 | `LAS-187` | `deploy/backup.sh` (atomic Postgres dump plus Caddy archives, manifest, checksums, flock, retention), `deploy/restore.sh` (checksum-gated production and drill Postgres restore, Caddy restore), mandatory pre-deploy backup in `release.sh`, bootstrap backup directory and daily timer with one initial set, four `verify-host` checks, `npm run smoke:backup`, real compose backup and restore legs, release ordering isolation, provisioning/README docs; `./scripts/init.sh`, 197 tests, acceptance 145 checks, compose/provision/backup/release/webhook smokes green; live deploy run 44578798179 with the pre-deploy set `tag=curved:ec6666d`, timer installed, first nightly set verified, `verify-host` 26 PASS, and a live Postgres drill restored 1 project/3 issues with `LIVE-1` at `done` while the app stayed 200. |
| 040 | `LAS-188` | `deploy/keepalive.sh`, bootstrap-installed `/usr/local/bin/curved-keepalive` plus hourly `curved-keepalive.service`/`.timer`, `verify-host` `keepalive-timer` check (27 PASS), provisioning-smoke unit/script/idempotency/disabled-timer coverage (52 PASS), and the section 18 keepalive plus rebuild-after-reclamation runbook; live bootstrap `--no-stack` installed the units, `verify-host` printed 27 PASS/0 FAIL, and a 62 s `/proc/stat` run measured 53-56% total CPU, p95 55%, average 54.1%. |
| 041 | Passkey login | Migration `0006` adds `passkey_credentials`, `auth_sessions`, and `webauthn_challenges`; sessions are opaque rows keyed by the SHA-256 of a 32-character base64url nonce in `curved_session` (30-day expiry, token and passkey logins, `DELETE /api/session` deletes the row), replacing the deterministic `sha256(UI_TOKEN)` cookie. `@simplewebauthn/server` 14.1 and `@simplewebauthn/browser` 14.0 back `GET /api/passkeys/available`, `GET`/`POST /api/passkeys`, `POST /api/passkeys/options`, `DELETE /api/passkeys/:id`, and unauthenticated `POST /api/session/passkey/options`/`POST /api/session/passkey`, with human routes accepting the bearer or the cookie. `CURVED_WEBAUTHN_ORIGINS` and `CURVED_WEBAUTHN_RP_ID` override defaults derived from `CURVED_DOMAIN`, which compose now passes. The SPA leads sign-in with a passkey button and manages passkeys from the topbar, sidebar, and palette. The UI-token field opts out of credential-manager autofill (`name="ui-token"`, `autoComplete="off"`, no autocapitalize/correct), so a saved password cannot overwrite a pasted token. Gates: 205 tests (199 behavior, 6 architecture), `architecture: ok (81 files)`, acceptance 145 checks with the two browser passkey lines, and compose smoke green. |
| 042 | UI token recovery | `.github/workflows/rotate-ui-token.yml` (manual `workflow_dispatch`, concurrency `rotate-ui-token`, contents read only) validates `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`, and `CURVED_UI_TOKEN`, writes the key and known_hosts under `$RUNNER_TEMP` mode 600, and pipes the token over stdin, never argv and never a log line. On the host it atomically rewrites the mode-600 `CURVED_UI_TOKEN` line in `/srv/curved/checkout/deploy/.env`, restoring the backup and re-running the release if `./deploy/release.sh` fails, then runs the release and proves `POST https://$CURVED_DOMAIN/api/session` with the new token returns 200 (`login probe ok`). Operator path: `gh secret set CURVED_UI_TOKEN < value`, then `gh workflow run rotate-ui-token.yml`; only the GitHub deploy key can reach the host, so local `ssh deploy@...` is denied. The token is also saved at `~/.curved-ui-token` (mode 600, outside the repo). Verified run 44747923125: `release: public probe ok`, `release: ok 2d1588c`, `login probe ok`; a scan of the full log for the token value returned 0 matches. |
| 043 | Project entity | Migration `0007_project_details.sql` gives `projects` a trimmed `summary` (<=255), `description` (<=20000), a six-value `status` (`backlog`/`planned`/`in_progress`/`paused`/`completed`/`canceled`, default `planned`), nullable 1..4 `priority`, `start_date`, `target_date`, `archived_at`, and `updated_at`, with a `planned`/`in_progress` backfill and four check constraints; no delete, archive is terminal, and project changes write only `updated_at`. Domain `PROJECT_STATUSES`/`ProjectStatus`/`DEFAULT_PROJECT_STATUS`/`isProjectStatus`, project types with `emptyProgress`, and project validators (summary trims, strict calendar `YYYY-MM-DD` dates); `ProjectRepository` adds `list({includeArchived})`, `findWithProgressByKey`, and a single-statement tri-state `update` with one lateral progress block; `createProject`/`listProjects`/`getProject`/`updateProject` are SQL-free and human-only for edits. HTTP `GET`/`POST /api/projects` and `GET`/`PATCH /api/projects/:key` (`includeArchived`, immutable key, nullable priority and dates, `archived` boolean; issue `PATCH` rejects `project`). CLI `project add|list|show|edit|archive|restore` with `--json` progress and `none` clears. The SPA adds the projects and `/p/<KEY>/overview` routes, `ProjectsPage`, `ProjectOverview`, `ProjectDialog`, `ProjectStatusChip`, five-cell mobile nav at 390 px, palette actions, and project navigation from issue detail, with realtime subscribing to all projects. The second-tab direct load exposed a deep-link race: project resolution could clear the timeline after the issue fetch, so the timeline effect now depends on `projectKeyFromRoute` and refetches. Gates: 223 tests (217 behavior, 6 architecture), `architecture: ok (84 files)`, acceptance 194 checks (five consecutive green runs after the race fix). |
| 044 | `LAS-188` completion | The live `158.101.127.247` was found to be an ephemeral public IP, not reserved, so the drill moved to reserved `129.213.209.162` and `https://curv3d.duckdns.org` (DNS-only DuckDNS A record). A fresh `curved-rebuild` A1 (2 OCPU/12 GB, AD-1, 50 GB boot) got a fresh 100 GB `curved-data-rebuild`; an online FULL backup of `curved-data` restored to `curved-restore-raw` (`is-hydrated: true`), `deploy/.env` and nightly `20261123T032302Z` were copied off-host with `SHA256SUMS` verified, and a current `pg_dump` (31 KB, 73 TOC entries) restored 2 projects/8 issues. `release.sh --require-public-probe` printed `release: public probe ok` and `release: ok d002ccd`; `verify-host` 27 PASS/0 FAIL after bootstrap now removes rpcbind 111/tcp+udp; UI sign-in reached `/p/CRV`, SSE `issues_changed` arrived, signed webhook ping returned 200 and unsigned 401; GitHub hook 715784553 replaced 714067501. Deploy secrets rotated (`DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SSH_KEY`); manual dispatch run 45191364607 passed Verify and Deploy. Old `curved` instance stopped with boot and `curved-data` volumes kept. |
| 045 | `LAS-189` | `deploy/agent-tunnel.sh` forwards `55433` to `127.0.0.1:55432` with strict SSH and refuses `55432`, so the local development listener survives; `deploy/agent-preflight.sh` compares checkout `HEAD` to `/srv/curved/release-state` and supports `--require-tunnel`; `scripts/agent-smoke.sh` plus the `smoke:agent` package script run 16 checks (local listener preserved, tunnel parse/refusal, strict SSH options, preflight parity and tunnel-required negatives, token handling). `deploy/provisioning.md` section 19 and `README.md` document the tunnel, preflight, MCP stdio entry, gates, and status. Gates: `npm run check` green with 223 tests and `architecture: ok (84 files)`, `npm run smoke:agent` prints `agent-smoke: ok (16 checks)`. Live proof on 2026-11-23 against `https://curv3d.duckdns.org`: local `HEAD` and release-state both `de5c863`, preflight `--require-tunnel` ok, `55432` local and `55433` tunnel, an agent created via the CLI in the app image with a one-time `crv_` token in a mode-600 home file (never printed), CLI projects `PRFTEINIO`/`OTHTEINIO` and issues `PRFTEINIO-1`/`2`/`3` and `OTHTEINIO-1`, a human HTTP relation blocking `PRFTEINIO-2` on `PRFTEINIO-1`, all eight MCP tools, blocked issue omitted from `list_ready`, `claim_next` claiming `PRFTEINIO-1`, a second claim filtered to `OTHTEINIO` failing `agent_busy` naming `PRFTEINIO-1`, `done` releasing the blocker so `PRFTEINIO-2` became ready and was claimed, `mark_blocked` returning it to `todo`, both projects archived, and the relation unblocked. Next: `LAS-190`. |
| 046 | `LAS-190` | Added `test/server-entry.test.ts`, which spawns the real `src/composition/server.ts` in a temp cwd with `CURVED_UI_TOKEN=""` and an unreachable `DATABASE_URL`, and asserts exit 1, the `CURVED_UI_TOKEN is required to start the HTTP server` stderr line, no `curved listening` stdout, and no `ECONNREFUSED` (proving no DB attempt). Live at deployed `57ced3d`: `docker run --rm -e CURVED_UI_TOKEN= curved:57ced3d` printed the guard and `exit=1`; first-run setup created `FIRST`/`First Run` through the SPA against a throwaway `curved_las190_firstrun` database on the deployed Postgres (row `FIRST|First Run|planned|0` issues, no SQL insert), with session persistence on reload; the throwaway container, database, env file, and forward were removed. Seeded `LAS190` through the deployed CLI (four issues, agent block of `LAS190-1`, claim of `LAS190-2`, human label on `LAS190-3`), then a 390x844 Chromium/CDP run over `https://curv3d.duckdns.org` passed 77 checks: token sign-in, session persistence across navigation (`/api/me` 200, `navType=navigate`), board blocked badge and label chips, queue `Ready=2 In flight=1 Blocked=1` with rows and Unblock buttons, detail created event and comment, labels editor, relation confirmed on both API sides, human unblock clearing the panel and dropping the blocked count to 0, palette key match, human SSE in 251 ms and agent SSE in 101/201 ms into two tabs without reload, and four screenshots under `/tmp`. Released `LAS190-2` and archived `LAS190`; issues and timeline remain. Documented the runbook in `deploy/provisioning.md` section 20 and updated README, AGENTS, and MEMORY. Gates: `npm run check` 224 tests (218 behavior, 6 architecture), `architecture: ok (84 files)`, `npm run acceptance` 194 checks. The follow-up commit is the test and docs only, so the product code matches the accepted `57ced3d` image. |
| 047 | Passkey domain scoping | A passkey registered at `158.101.127.247.sslip.io` could not authenticate at `curv3d.duckdns.org` because WebAuthn binds a credential to one RP ID, and the server still offered the stale credential in login `allowCredentials`, so iOS showed its cross-device QR sheet instead of Face ID. Migration `0008_passkey_rp_id.sql` adds nullable `passkey_credentials.rp_id` with a format check; pre-migration rows stay NULL and inert. `PasskeySummary`/`PasskeyRecord` carry `rpId: string \| null` and `usable`; `PasskeyRepository` adds `listForRpId` and `countForRpId` and `create` requires `rpId`; `passkeysAvailable(ports, rpID)` returns `{ available, otherDomain }`, served by `GET /api/passkeys/available` (`cache-control: no-store`), while `GET /api/passkeys` annotates each row with `rpId`/`usable`; login options offer only current-domain credentials with `hints: ["client-device"]`, fail validation with "no passkey is registered for this domain" when none exist, and return 401 when completion uses an other-domain credential; registration stores the current RP ID and excludes only usable ids; config lowercases the RP ID. The SPA disables the passkey button and explains the move when only stale rows exist, and `PasskeysDialog` tags them "Different domain" while still allowing deletion. `test/passkeys.test.ts` covers current versus other-domain availability counts, the listing annotation, registration exclusion, login options, and other-domain sign-in rejection; `scripts/acceptance.mjs` adds the sign-in-only `browser-signin` leg, which seeds a NULL-`rp_id` row and asserts the disabled button and explanation. Gates: 228 node tests (222 behavior, 6 architecture), `architecture: ok (84 files)`, `npm run acceptance` 197 checks; the deployed host was not reachable from this workstation, so release and re-registration remain for the operator. |
| 048 | CRV-4 blocking relationships | Relation edges are now removable and settable at creation and edit time. Backend: `RelationRepository.remove` deletes an edge via `delete from issue_relations ... returning blocking_issue_id`; `removeRelation(ports, { blocked, blocking, actor?, agent? })` is human-only (`forbidden_transition`), rejects a self edge (`validation`) and unknown keys (`not_found`), removes idempotently inside one transaction, and appends a `relation` event body `{"blocking","blocked","removed":true}` only when a row was removed; `DELETE /api/issues/:key/relations/:blocking` maps those codes to 400/403/404 and returns `{ issue }`. Web: `relationSummary` renders "X no longer blocks Y"; `relationCandidates(issues, { excludeKey?, includeKeys? })` keeps every non-Done same-project issue plus existing relations (even Done/cross-project), sorted numerically; `NewIssueInput` gains `blocks`/`blockedBy`; `ApiPort.removeRelation` DELETE client; new `RelationSelect` (multi-select through `Field`) and `RelationsDialog` (one Save diffs all four directions) replace the inline single-input blocker form in `IssueDetail` (rows carry `relation-blocks-row`/`relation-blocked-by-row`, `edit-relations` opens the dialog); `NewIssueDialog` renders Blocked-by/Blocks dropdowns after Labels; `workspace.createIssue` applies relations post-create with a non-atomic error toast and `workspace.setRelations` diffs against the loaded issue (removed `issueKeys` and the old `addRelation`). No migration (the table and PK predate this). Gates: `npm run typecheck` and `npm run check:arch` green (`architecture: ok (86 files)`), `npm test` 231 pass (was 228; +3 removal tests, extended HTTP DELETE cases), `npm run build:web` green, a throwaway-DB HTTP proof (POST -> blockedBy, DELETE -> empty, two events add+removed, idempotent repeat, self 400, unknown 404, agent 403), and `npm run acceptance` 197 checks including `PASS browser: create modal relation TAC-2 rendered on TAC-27`, `PASS browser: relations modal added TAC-3 as a block`, and `PASS browser: relations modal removed TAC-2`. |
