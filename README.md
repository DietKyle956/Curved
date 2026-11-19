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

## Surface

- **Agent tools**: `list_ready`, `claim_next`, `comment`, `submit_for_review`,
  `mark_blocked`, `release_claim`, plus issue reads and creates.
- **Human board**: mobile-first SPA with five status lanes, a ready queue, an issue
  detail view with the full timeline, and a `Cmd/Ctrl+K` palette. Sign-in uses the
  UI token; the first run creates a project.
- **Automation**: `POST /webhooks/github`, which moves issues when a pull request
  opens, reopens, or merges, and `node src/composition/cli.ts git-branch <KEY>`,
  which names the branch for an issue.
- **Transport**: one process serving the HTTP API, the SPA, and the SSE stream.

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

The authenticated HTTP boundary is live. `npm start` runs
`node src/composition/server.ts` on `PORT` (default 4747) and refuses to start
without `CURVED_UI_TOKEN`. The web client is a Vite + React + Tailwind app in
`web/`, built into `web/dist` and served by the same process. Requests
authenticate as a human through the session cookie or the UI bearer token, or as
an agent through a `crv_` bearer token; failures and service errors share one JSON
error shape, and there is no CORS. The API covers projects, issues, comments,
transitions, block/unblock, release, claims, labels, and relations, and serves the
SPA from `web/dist` for other paths; `POST /webhooks/github` is the one non-`/api`
route with its own HMAC gate. See "HTTP API" below.

Realtime is live. Migration `0005` adds `notify_issue_change()`, which fires on
`after insert` and `after update` of `issues` and on `after insert` of
`issue_events`, calling `pg_notify('issues_changed', project_id::text)` for the
owning project. `GET /api/events` is a cookie-authenticated `text/event-stream`
that sends `ready` once the subscription exists, one `issues_changed` frame per
notification carrying the project id as `data`, and a `ping` every 25 seconds.
One lazily opened shared `pg.Client` per app runs a single `LISTEN
issues_changed` and fans notifications out to that app's subscribers. The web
client now drives refreshes from the stream instead of polling.

Labels are per project: a label name is unique within its project, trimmed, 1 to
50 characters, and reused by every issue in that project that carries it. Setting
an issue's labels replaces its whole set, and an empty set clears it. Relations
are directed and only express blocking: one issue blocks another. Both are
append-only timeline events with JSON bodies, a `labels` event carrying the sorted
label names and a `relation` event carrying the blocking and blocked keys. Every
issue payload carries `labels` and `relations: { blocks, blockedBy }`, where
`blocks` holds the keys this issue blocks and `blockedBy` the keys blocking it.
`ready` and `claim` exclude an issue while any issue blocking it is not `done`.

- `node src/composition/cli.ts issue add <PROJECT> <title...>` - create an issue;
  keys are assigned atomically.
- `node src/composition/cli.ts issue list [PROJECT]` - list issues, optionally
  scoped to one project; the fifth column is the blocked reason or `-`.
- `node src/composition/cli.ts issue show <KEY>` - print the issue and its
  timeline in ascending event order, plus its `labels`, `blocks`, and
  `blocked_by`.
- `node src/composition/cli.ts issue comment <KEY> <body...> [--actor <type>]
  [--agent <name>]` - append a comment event to the timeline.
- `node src/composition/cli.ts issue move <KEY> <status> [--body <text>]
  [--actor <type>] [--agent <name>]` - move an issue along a legal edge for the
  given actor.
- `node src/composition/cli.ts issue block <KEY> <reason...>` - block a claimed
  issue with a reason; returns it to `todo`, clears the claim, and appends a
  `blocked` event; requires `CURVED_AGENT_TOKEN`.
- `node src/composition/cli.ts issue unblock <KEY> [--actor <type>]
  [--agent <name>]` - clear a blocked issue's reason and append an `unblocked`
  event; humans only.
- `node src/composition/cli.ts agent add <name>` - create an agent; prints its
  `crv_` token once, and only the SHA-256 hash is stored.
- `node src/composition/cli.ts ready [PROJECT] [--human]` - list unblocked
  `todo` issues by priority then number, with the caller's busy key; requires
  `CURVED_AGENT_TOKEN` unless `--human` is passed.
- `node src/composition/cli.ts claim [PROJECT]` - claim the next ready issue
  with `for update skip locked`; requires `CURVED_AGENT_TOKEN`.
- `node src/composition/cli.ts review <KEY> <summary...>` - submit a claimed
  issue for review; requires `CURVED_AGENT_TOKEN`.
- `node src/composition/cli.ts release <KEY>` - return a claimed issue to
  `todo`; requires `CURVED_AGENT_TOKEN`.
- `node src/composition/cli.ts git-branch <KEY> [--json]` - print the branch
  name for an issue, the canonical key plus a slug of its title; `--json` prints
  `{ "key": ..., "branch": ... }`.
- `npm run db` - start Postgres and apply migrations.
- `npm run dev` - run the Vite dev server on port 5173 and proxy `/api` to
  `http://127.0.0.1:4747`; start `npm start` in another terminal.
- `npm run build` - typecheck, then build the SPA into `web/dist`.
- `npm start` - run the HTTP server and SPA on `PORT` (default 4747); requires
  `CURVED_UI_TOKEN`. Run `npm run build` first for the SPA.
- `./scripts/init.sh` - install, database, check, build.
- `./scripts/clean-state.sh` - end-of-session gate.
- `npm run smoke:container` - container contract gate: local Postgres, image
  build, and runtime assertions. See "Container image" below.
- `npm run smoke:provision` - local provisioning gate: runs the host bootstrap
  and verifier against Ubuntu 24.04 stubs in a disposable container. See
  "Provisioning the Oracle host" below.
- `npm run smoke:release` - release gate: drives `deploy/release.sh` and its
  rollback against stub binaries, with no Docker, database, or network. See
  "Releasing" below.
- `npm run smoke:webhook` - webhook gate: exercises `deploy/webhook.sh` against
  a stub `gh`, covering the create and update paths without a GitHub account or
  network. See "GitHub webhook" below.
- `npm test` - tests run against the isolated `curved_test` database.
- `npm run check` - typecheck, the import-direction architecture check, then the
  tests.
- Working agreement: `AGENTS.md`
- Current state and next step: `MEMORY.md`

## Container image

The root `Dockerfile` is a multi-stage `node:26-slim` build. The build stage runs
`npm ci`, `npm run build:web`, and `npm prune --omit=dev`; the runtime stage
copies `package.json`, the production `node_modules`, `src`, `migrations`, and
`web/dist`, and runs as the non-root `node` user. The runtime needs only
`DATABASE_URL`, `PORT`, and `CURVED_UI_TOKEN`. The image intentionally excludes
`.env`, tests, `scripts`, and deployment assets. The example below uses host
networking so `127.0.0.1:55432` reaches the Postgres running on the host.

```sh
docker build -t curved:latest .
docker run --rm --network=host \
  -e DATABASE_URL=postgres://curved:curved@127.0.0.1:55432/curved \
  -e PORT=4747 \
  -e CURVED_UI_TOKEN=<your token> \
  curved:latest
```

`npm run smoke:container` runs `bash scripts/container-smoke.sh`, the container
contract gate. It starts the local Postgres with `scripts/db.sh`, builds
`curved:container-smoke`, runs it with host networking on a temporary port and
token, and asserts the SPA shell, `401` for an unauthenticated
`GET /api/projects`, `200` for the authenticated call, the in-image
`node src/composition/migrate.ts` reporting `already up to date`, a non-root uid,
and the absent `.env`, test, script, and deployment paths.

`--platform <platform>` builds and runs the image for another architecture, for
example `--platform linux/arm64`, when the host can execute that platform.
`--build-only` stops after a successful build, so a cross-architecture build such
as `--platform linux/arm64 --build-only` proves the Dockerfile is
architecture-neutral without emulating the runtime. `--keep` keeps the built
image. The Dockerfile is architecture-neutral: it builds natively on x64 locally
and on the arm64 VM.

## Production compose stack

"Container image" above covers the artifact; this section covers the stack that
runs it. `deploy/docker-compose.yml` is the production stack under the Compose
project `curved-prod`, with three services:

- `db` is `postgres:18-alpine`, published only on
  `127.0.0.1:${CURVED_DB_PORT:-55432}:5432`.
- `app` builds the root `Dockerfile`, runs migrations and then the server, and
  publishes no host port at all.
- `caddy` is `caddy:2.10-alpine`, publishing `${CURVED_HTTP_PORT:-80}:80`,
  `${CURVED_HTTPS_PORT:-443}:443`, and 443/udp.

Startup is health-gated in order: `db` healthy, then `app` healthy, then
`caddy`. Only Caddy faces the network, and Postgres is reachable only from
loopback on the host. The development `docker-compose.yml` at the repository root
is unchanged.

Setup:

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
$EDITOR deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
```

Because the compose file lives in `deploy/`, Compose reads `deploy/.env`
automatically: the same file feeds variable interpolation and the containers.
Fill `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `CURVED_UI_TOKEN`,
`GITHUB_WEBHOOK_SECRET`, `CURVED_DOMAIN`, `ACME_EMAIL`, and
`CURVED_HSTS_MAX_AGE`, and keep `COOKIE_SECURE=1` for the HTTPS stack. The file
also carries optional host-port and image overrides. It is gitignored, so
secrets stay out of the repository.

TLS is local by default. With `CURVED_DOMAIN=localhost` and an empty
`ACME_EMAIL`, Caddy issues its own certificate from its internal CA, so
`https://localhost` serves immediately and the browser warns once. Trust the
stack's root CA to silence the warning; the smoke gate extracts the same file:

```sh
docker compose -f deploy/docker-compose.yml exec caddy \
  cat /data/caddy/pki/authorities/local/root.crt > /tmp/curved-caddy-root.crt
```

Import `/tmp/curved-caddy-root.crt` into the browser or system trust store.

A public deployment sets `CURVED_DOMAIN` to the DNS-only hostname that points at
the server, `ACME_EMAIL` to a real address, and `CURVED_HSTS_MAX_AGE` to
`31536000`. Caddy then obtains a Let's Encrypt certificate over the ACME
challenge, redirects `http://` to `https://` (a 308), and sends
`Strict-Transport-Security: max-age=31536000`. HSTS is sent only while
`CURVED_HSTS_MAX_AGE` is set, so a localhost stack never pins HSTS in a browser;
the release probe and the compose gate both check that toggle. Caddy compresses
responses with zstd or gzip except on `/api/events`, which is proxied with
`flush_interval -1` so SSE frames reach the browser immediately.

The live host runs this way at `https://158.101.127.247.sslip.io`. The name comes
from sslip.io wildcard DNS, which resolves `158.101.127.247.sslip.io` to the
reserved IPv4 `158.101.127.247`; the record is DNS only, so the ACME HTTP and
TLS-ALPN challenges reach Caddy directly. Its certificate is issued by Let's
Encrypt for `158.101.127.247.sslip.io` (issuer `YE2`, valid to Feb 17 2027), and
the container sees `ACME_EMAIL=admin@sslip.io`, `CURVED_DOMAIN` set to that
hostname, and `CURVED_HSTS_MAX_AGE=31536000`. Through the public edge the SPA and
JS assets, the authenticated API, and the SSE stream answer over verified TLS,
and the API's unauthenticated `GET /api/projects` stays a 401.

Operations:

```sh
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f app
docker compose -f deploy/docker-compose.yml down
```

`ps` reports each service's health. The `app` health check authenticates with
`CURVED_UI_TOKEN` against `/api/projects`, so `healthy` means the API answers
real requests, not merely that the port is open. `logs -f app` follows the
server; swap in `db` or `caddy` for the others. Postgres binds only to
`127.0.0.1:55432` on the host, which is what an SSH tunnel targets when an agent
on another machine needs the database; the tunnel's local port uses 55433 as the
future convention, and the stack does not set one up. `down` without `-v` stops
and removes the containers while keeping the volumes.

**`docker compose -f deploy/docker-compose.yml down -v` deletes the Postgres and
Caddy volumes: every project, issue, event, and the database itself, plus Caddy's
data volume with the internal CA and every ACME account and certificate. Never
run it on the server.**

`npm run smoke:compose` runs `bash scripts/compose-smoke.sh`, the gate for this
stack. It builds and starts the stack under a throwaway Compose project and a
generated env on free high ports, extracts Caddy's internal root CA, and asserts
over HTTPS: the SPA shell, the `308` redirect from HTTP to HTTPS, no HSTS while
`CURVED_HSTS_MAX_AGE` is empty and `Strict-Transport-Security: max-age=31536000`
after enabling it, a gzip-compressed JS asset, `401` then `200` on
`/api/projects`, the `Secure` session cookie, project and issue creation,
`/api/ready`, issue detail, `/api/issues`, an SSE `ready` frame plus an
`issues_changed` frame for the project within 5s, `401` for an unsigned
`POST /webhooks/github`, the loopback-only Postgres bind, and that `app`
publishes no host port. `npm run smoke:compose -- --keep` keeps the smoke image
for inspection.

## Provisioning the Oracle host

"Production compose stack" above is what the server runs; this section is the
host it runs on. `deploy/provisioning.md` is the full console runbook, from the
VCN to the acceptance evidence. The summary:

One Always Free `VM.Standard.A1.Flex` instance with 2 OCPU and 12 GB of memory
runs Ubuntu 24.04 aarch64 in the tenancy's home region. It has a 50 GB boot
volume, a 100 GB block volume, and one reserved public IPv4. The live name comes
from sslip.io wildcard DNS; with your own domain, use a DNS-only (never proxied)
`A` record so the origin stays directly reachable. The host serves the public
HTTPS stack: Caddy obtains a Let's Encrypt
certificate for `158.101.127.247.sslip.io` through ACME, redirects HTTP to HTTPS,
sends HSTS for a year, compresses responses outside the SSE route, and flushes
`/api/events` without buffering. The sslip.io wildcard name resolves straight to
the reserved IPv4, so the ACME challenge reaches port 80 on the host.

The network boundary is four ingress rules and nothing else:

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH, key-only, `ubuntu` and `deploy` only |
| 80 | TCP | Caddy HTTP, the HTTPS redirect, and the ACME challenge |
| 443 | TCP | HTTPS |
| 443 | UDP | HTTP/3 |

There is no public 5432 and no public 4747. Postgres is published only on
`127.0.0.1:55432` on the host, which is what an SSH tunnel targets, and `app`
publishes no host port. SSH is key-only with password and root login disabled
through `/etc/ssh/sshd_config.d/00-curved-access.conf`. The `deploy` account is
in the `docker` group, which is root-equivalent: Docker can mount the host
filesystem, so treat its key as a root key.

Storage is 50 GB boot plus 100 GB data: 150 of the 200 GB Always Free block
storage allowance, with 50 GB headroom. The data volume is ext4, mounted at
`/srv/curved` with a `nofail` fstab entry, and holds the checkout at
`/srv/curved/checkout` and the environment file at
`/srv/curved/checkout/deploy/.env` (mode 600, owner `deploy`, generated once,
never printed). Docker's data-root is `/srv/curved/docker` on the data volume:
the `docker.service` drop-in sets `RequiresMountsFor=/srv/curved/docker` and
`ConditionPathIsMountPoint=/srv/curved`, so Docker refuses to start while the
mount is missing. Container logs rotate at 10 MB x 3 through `json-file`, and
`curved-docker-prune.timer` runs daily at 04:37 to prune build cache older than
7 days and unused images older than 30 days. The 50 GB boot volume holds the OS
only.

Two commands do the work, both as root on the server. Run the first from the
provisioning clone (`~/curved-provision`):

```sh
sudo bash deploy/bootstrap-host.sh --key ~/.ssh/id_ed25519.pub \
  --domain <domain> --data-device /dev/sdb
sudo bash /srv/curved/checkout/deploy/verify-host.sh --domain <domain>
```

`deploy/bootstrap-host.sh` is idempotent: it installs Docker, creates the key-only
`deploy` account and the sshd drop-in, prepares and mounts the data device,
clones the repository, writes `deploy/.env`, and starts the Compose stack.
`deploy/verify-host.sh` is read-only and prints `PASS` or `FAIL` for the OS, the
`deploy` account, sshd policy, the data mount, storage accounting,
`docker-root`, `docker-config`, `docker-mount-dependency`, `docker-prune-timer`,
the environment file, the checkout, the TCP and UDP listeners, the stack
health, `tls-certificate` (a verified HTTPS response to the API), `http-redirect`
(HTTP to HTTPS), `hsts` (the configured max-age), `compression` (a compressed
asset), `caddy-issuance` (an ACME certificate obtained for the domain in the
Caddy log), and `https-api` (200 authenticated, 401 unauthenticated). On the live
host it exits 0 with 22 PASS lines. The bootstrap ends with
`bootstrap-host: ok` and the verifier with `verify-host: ok`; any other ending
is a failure. A reboot proof is in `deploy/provisioning.md` section 9.4.

LAS-183 provisions the host, LAS-184 makes its data durable, LAS-185 adds the
release script and SSH deploy job described under "Releasing", and LAS-186
delivers the public edge: Let's Encrypt TLS, the HTTP to HTTPS redirect, HSTS,
SSE without buffering or compression, and the public GitHub webhook. The OCI
console steps and the live host checks are operator-executed; backups are
LAS-187.
`npm run smoke:provision` is the repository-side proof: it runs the bootstrap
and verifier inside a disposable container against Ubuntu 24.04 stubs and proves
the Docker data root, mount gate, log rotation, and prune timer, the public-mode
environment generated by `--acme-email`, the public verifier checks (certificate,
redirect, HSTS, compression, ACME issuance), and their negatives, so a change to
either script is caught without an OCI tenancy.

## Releasing

A push to `main` deploys. `.github/workflows/verify.yml` still runs `verify`,
and a second job, `deploy`, declares `needs: verify` and
`if: github.ref == 'refs/heads/main'`, so it cannot start before verification
passes or from any branch. The runner has no checkout and no write permission:
it validates three repository secrets, writes two of them under `$RUNNER_TEMP`
with mode 600, and runs one SSH command as `deploy@<host>`.

- `DEPLOY_SSH_KEY` - the private key for the `deploy` account.
- `DEPLOY_KNOWN_HOSTS` - the pinned `known_hosts` line for the server, so host
  verification fails closed instead of trusting a first-seen key.
- `DEPLOY_HOST` - the server's hostname or address.

The remote command is `cd /srv/curved/checkout && git fetch --prune origin main
&& git reset --hard origin/main && ./deploy/release.sh`, because the server's
own checkout is the only code that ships. A manual dispatch
(`workflow_dispatch`) exposes a `skip_public_probe` boolean that appends
`--skip-public-probe`. SSH runs with `BatchMode=yes`, `IdentitiesOnly=yes`,
`StrictHostKeyChecking=yes`, and that pinned known_hosts file, so an unknown or
changed host key fails the job. The `deploy` account is in the `docker` group,
which is root-equivalent, so treat `DEPLOY_SSH_KEY` as a root key.

`deploy/release.sh` is the release itself, run on the server from the checkout.
It resolves the repository root through git, requires the env file, refuses to
run when both probe flags are given, tags the image `curved:<short>` for the
seven-character HEAD commit, and follows a fixed order:

1. `docker compose -p curved-prod --env-file deploy/.env -f
   deploy/docker-compose.yml up -d --wait --wait-timeout 300 db`.
2. Build `app` with `CURVED_IMAGE=curved:<short>`.
3. Run `node src/composition/migrate.ts` once in a throwaway container with
   `run --rm --no-deps -T app`. A failing migration exits the script immediately
   and prints that the previous app is still serving; the app and Caddy are not
   recreated, nothing is retagged, and no release state is written.
4. Recreate `app` alone with the new image, `--no-deps --wait
   --wait-timeout 600`.
5. Recreate `caddy` alone.
6. Probe `https://$CURVED_DOMAIN/api/projects` with the UI bearer token, a
   ten-second request timeout, and 30 attempts two seconds apart. With an empty
   `ACME_EMAIL` the probe extracts Caddy's internal root CA from
   `/data/caddy/pki/authorities/local/root.crt` and passes it as `--cacert`.
   With a non-empty `ACME_EMAIL` it verifies the public certificate against the
   system trust and requires a `Strict-Transport-Security` header, whose max-age
   must equal `CURVED_HSTS_MAX_AGE` when that is set. The token never reaches
   the output.
7. After a successful probe, tag `curved:<short>` as `curved:latest`, write the
   release state atomically, and print `release: ok <short>`.

The probe is what makes a release fail after the containers are up. Its rules
depend on `--state-file`, which defaults to
`${CURVED_RELEASE_STATE:-/srv/curved/release-state}` and sits outside the
checkout, so `git reset --hard` cannot touch it:

- No state file means a first deploy: the probe is skipped with a loud message
  unless `--require-public-probe` is passed. The skip still counts as a
  successful release, so `curved:latest` moves and the state file is written.
- With a state file, a failed probe exits nonzero and leaves both the state file
  and `curved:latest` untouched, so a release that cannot be reached publicly is
  never recorded.
- `--skip-public-probe` skips the probe on any deploy with a warning.

The state file records the tag (`curved:<short>`), the short SHA, and the UTC
timestamp. `--env-file` and `--compose-file` override the `deploy/.env` and
`deploy/docker-compose.yml` defaults, and `--help` prints the usage. The script
never runs `docker compose down` or `down -v`.

The live host proves the public path: deploy run 44551897724 logged
`release: public probe ok` and `release: ok c711540`, so the ACME certificate
verified against the system trust, the HSTS header was present, and its max-age
matched `CURVED_HSTS_MAX_AGE=31536000`.

To release by hand on the server, or to retry a failed probe:

```sh
cd /srv/curved/checkout
./deploy/release.sh
./deploy/release.sh --skip-public-probe
./deploy/release.sh --require-public-probe
```

To roll back, name the tag to restore:

```sh
./deploy/release.sh rollback <tag>
```

`rollback` normalizes `curved:<tag>`, requires the image to exist locally
(`docker image inspect`), and runs no migrations. It recreates `app` and then
`caddy` with `CURVED_IMAGE=curved:<tag>`, applies the same public-probe rules,
and updates the state file on success. It also prints that a migration which is
not backward compatible needs a database restore instead of an image rollback:
the newer schema stays in place when the older image returns.

`npm run smoke:release` runs `bash scripts/release-smoke.sh`, the gate for this
path. It drives the script against stubbed `git`, `docker`, `curl`, and `sleep`
binaries in a temporary `PATH`, with no Docker, database, or network, and
asserts the ordering, the migration failure path, the first-deploy skip, the
second-deploy probe failure, the public probe's HSTS requirement (a matching
max-age passes, a missing header or a mismatched max-age is fatal and leaves
`curved:latest` and the state file untouched), rollback, and that the bearer
token never appears in the output.

## Continuous integration

`.github/workflows/verify.yml` runs on every push to `main` and on manual
dispatch. One global concurrency group, `verify`, with
`cancel-in-progress: false`, queues runs so two never execute at once: a new run
waits for the running one instead of interrupting it, so an in-flight
verification is never interrupted by a newer push.

The `verify` job runs on `ubuntu-latest` with a 20 minute timeout and read-only
contents permission. It starts a `postgres:18-alpine` service container
published on host port 55432 with the same `curved` user, password, and database
as `docker-compose.yml`, gated by `pg_isready`. The job pins Node 26 with the
npm cache, runs `npm ci`, then `npm run typecheck`, `npm run check:arch`,
`npm test`, and `npm run build:web`. `DATABASE_URL` and `TEST_DATABASE_URL` are
set explicitly to the repository defaults,
`postgres://curved:curved@127.0.0.1:55432/curved` and the `curved_test` database
on the same server.

A second job, `deploy`, declares `needs: verify` and
`if: github.ref == 'refs/heads/main'`, so it cannot run before verification
passes or from any branch. It deploys to the host over SSH as described under
"Releasing": the workflow gives it no checkout and no write token.

## Acceptance gate

`npm run acceptance` is the end-to-end gate for the shipped entry points. It runs
`bash scripts/acceptance.sh`, which starts Postgres with
`bash scripts/db.sh --no-migrate` (readiness only, so the local `curved` database
gets no migrations), rebuilds `web/dist` with `npm run build:web` so the browser
leg exercises the tree under test, then hands off to
`node scripts/acceptance.mjs`.

The orchestrator creates one throwaway database,
`curved_acceptance_<pid>_<epoch>`, from `DATABASE_URL` (falling back to the repo
`.env`, then `postgres://curved:curved@127.0.0.1:55432/curved`), migrates it, and
runs every leg against it:

- `cli` - `project add`, `agent add`, `issue add`, then `ready` with its busy
  line, `claim`, a second claim returning `agent_busy`, `review`, a human
  `issue move` to done, and the `no_ready_issue` exit code.
- `mcp` - the eight tools over NDJSON stdio, checked against the expected
  `tools/list` names.
- `server` - `npm start` on a free port until it prints its listening line, with
  fresh `CURVED_UI_TOKEN` and `GITHUB_WEBHOOK_SECRET` values.
- `http+sse` - the UI bearer and the session cookie, the `ready` frame, an
  `issues_changed` frame for the acceptance project, and the built SPA.
- `webhook` - a signed `pull_request` delivery moves an issue to `in_review`, and
  the replay answers `ignored` without adding a second event.
- `browser` - `scripts/acceptance-browser.mjs` drives Chromium at 390x844 through
  sign-in, the five status tabs, palette-driven issue creation, a comment, and a
  second tab that updates in under 1100ms.

Prerequisites: Docker with Postgres from `docker compose up -d`, and Chromium
found on `PATH` as `chromium`, `chromium-browser`, `google-chrome`, or
`google-chrome-stable`, or named by `CHROMIUM_BIN`.

Two flags reach `node scripts/acceptance.mjs` through
`npm run acceptance -- <flag>`:

- `--skip-browser` - skip the browser leg, for a machine without Chromium.
- `--keep` - keep the throwaway database and print its name instead of dropping
  it.

The browser leg writes run-scoped screenshots to the system temp directory
(`curved-acceptance-<run id>-board.png`, `-detail.png`, `-second-tab.png`) and
prints each path on its `PASS browser:` line.

Exit codes: `0` when every check passes, `1` on a failed check, a failed leg, or a
cleanup failure, and `2` on an unknown argument. Cleanup stops the children, drops
the throwaway database unless `--keep`, then re-digests the default database and
fails when any row of `projects`, `issues`, `issue_events`, `agents`, `labels`,
`issue_labels`, `issue_relations`, or `schema_migrations` changed. `SIGINT` or
`SIGTERM` cleans up the same way and exits `1`. Each `PASS <leg>:` and
`FAIL <leg>:` line names the leg that produced it.

The gate builds on the other two entry points rather than replacing them:
`./scripts/init.sh` is still the baseline (install, database, check, build) and
`./scripts/clean-state.sh` is still the end-of-session gate. This is the only one
that runs the CLI, MCP server, HTTP server, webhook, and SPA together.

The repository-side gates all pass: `npm run check` passes 197 tests plus the
architecture check, `npm run smoke:compose` covers the HTTP to HTTPS redirect, the
HSTS toggle before and after enabling `CURVED_HSTS_MAX_AGE`, gzip on the JS asset,
and an `issues_changed` frame within 5s, `npm run smoke:provision` reports 42
PASS, `npm run smoke:release` 20 PASS, and `npm run smoke:webhook` 9 PASS.

## HTTP API

`node src/composition/server.ts` (or `npm start`) serves the JSON API under
`/api`, the GitHub webhook at `/webhooks/github`, and the SPA for every other
path. One process owns all of it.

Prerequisites:

1. Postgres: `docker compose up -d`.
2. Schema: `npm run migrate`.
3. A UI token: export any secret as `CURVED_UI_TOKEN`. The server refuses to start
   without it and exits 1 with
   `CURVED_UI_TOKEN is required to start the HTTP server`.
4. Agent tokens for `crv_` bearers:
   `node src/composition/cli.ts agent add <name>`.
5. For the GitHub webhook: export `GITHUB_WEBHOOK_SECRET`, the same secret you
   give the repository webhook. `POST /webhooks/github` answers
   `503 webhook_not_configured` until it is set.
6. Over HTTPS only: export `COOKIE_SECURE=1` so the session and logout cookies
   also carry `Secure`.

`PORT` defaults to 4747. `COOKIE_SECURE` defaults off: the login and logout
`Set-Cookie` values keep `HttpOnly; SameSite=Lax; Path=/; Max-Age=...` and omit
`Secure`. Set `COOKIE_SECURE=1` (or `true`) when the app is served over HTTPS and
both cookies also carry `Secure`; local HTTP development and the acceptance gate
leave it unset.

Authentication has two lanes. A human session is either
`Authorization: Bearer <CURVED_UI_TOKEN>` or the `curved_session` cookie minted by
`POST /api/session`. The cookie is the lowercase SHA-256 hex of the UI token and is
`HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`. Any other bearer is resolved as
an agent token through the `agents` table. A bearer that is present but invalid is
`401 not_authenticated`, even alongside a valid cookie, so a stale agent token is
never silently downgraded.

`GET /api/events` is the one exception: it authenticates by the `curved_session`
cookie only and ignores `Authorization`, because `EventSource` cannot set request
headers. A request with no cookie, including a bearer-only request, is
`401 not_authenticated` JSON.

`POST /api/session` is the only unauthenticated `/api` route; every other route,
including `GET /api/projects`, rejects requests without valid credentials with
`401 not_authenticated`.

`POST /webhooks/github` is outside `/api` and takes neither lane. It reads no
cookie and no bearer header and authenticates only as a GitHub delivery: the
`x-hub-signature-256` header must match the HMAC-SHA256 of the raw body keyed by
`GITHUB_WEBHOOK_SECRET`. A missing or mismatched signature is
`401 not_authenticated`, and the route responds `{"ok":true}` when it moved an
issue and `{"ok":true,"ignored":true}` otherwise, so GitHub never retries.

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
| `POST` | `/api/issues/:key/labels` | human only | `{ issue }`; body `{ labels }` replaces the label set, upserting project labels |
| `POST` | `/api/issues/:key/relations` | human only | `{ issue }`; body `{ blocking }`, where `:key` is the blocked issue |
| `GET` | `/api/ready` | human or agent | `{ ready, busy }` |
| `POST` | `/api/claims/next` | agent only | `{ issue }` |
| `GET` | `/api/events` | human session cookie only | `text/event-stream`; `ready`, `issues_changed` (project id as `data`), and a 25 second `ping` |
| `POST` | `/webhooks/github` | `x-hub-signature-256` HMAC of the raw body | Outside `/api`; `{"ok":true}` when an issue moved, `{"ok":true,"ignored":true}` otherwise |

Mutating `/api` requests with a body must send `Content-Type: application/json`;
anything else is `400 validation`. An empty body reads as `{}`. The API sends no
CORS headers, so browser clients run on the same origin.

Errors share one shape, `{ "error": { "code", "message" } }`. `validation` maps to
400, `not_authenticated` to 401, `forbidden_transition` to 403, `not_found` to
404, the remaining service codes such as `agent_busy`, `duplicate`, and
`illegal_transition` to 409, and an unexpected failure to 500 with the detail
logged to stderr. An unknown `/api` path returns a JSON 404 and never falls back to
HTML.

Everything outside `/api` other than `POST /webhooks/github` is served from
`web/dist`: a matching file, otherwise `index.html` for client-side routes. The
document is `cache-control: no-cache`; `/assets/*` is
`public, max-age=31536000, immutable`. When no build exists the response is a 503
text naming `web/dist` and the build command.

## GitHub webhook

`POST /webhooks/github` lets GitHub move issues, so a merged pull request retires
the issue without a human touching the board. The route sits outside `/api` and
shares no credential with it: a delivery is accepted only when the
`x-hub-signature-256` header equals the HMAC-SHA256 of the raw request body keyed
by `GITHUB_WEBHOOK_SECRET`. The raw body is read and checked before anything is
parsed, and it is rejected above 1 MiB.

The live repository hook posts to
`https://158.101.127.247.sslip.io/webhooks/github` (hook id 714067501, event
`pull_request`, content type `application/json`). Configure it with
`deploy/webhook.sh`: it derives the repository from `origin`, reads
`GITHUB_WEBHOOK_SECRET` and `CURVED_DOMAIN` from `deploy/.env`, and either
creates the hook or updates the existing hook with the same URL, so the secret is
reapplied on every run (GitHub never returns a stored secret). Pass
`--repo OWNER/NAME` and `--url URL` to target another repository or endpoint, and
`--dry-run` to print the plan. `npm run smoke:webhook` runs
`scripts/webhook-smoke.sh` against a stub `gh` and proves the create path, the
update path, the dry run, the missing-secret and localhost guards, and that the
secret never reaches the output or argv.

The `x-github-event` header must read `pull_request`; deliveries carrying any
other event value are ignored. `GITHUB_WEBHOOK_SECRET` must be exported for the
server process; until it is, the route answers `503 webhook_not_configured`. A
missing or wrong signature is `401 not_authenticated`, and a body that is not
valid JSON is `400 validation`.

Only `pull_request` events act, and the payload's `action` with the
`pull_request` object's `merged` decide the move. `opened` and `reopened` move
the issue to In Review; `closed` moves it to Done only when the pull request
merged. `closed` without a merge, every other action, and every other event are
acknowledged with `200 {"ok":true,"ignored":true}` so GitHub does not retry the
delivery. The same ignored response covers an unknown issue key, a key whose
issue cannot take the move, and a replay of a move already made.

The issue key is read from the pull request branch (`head.ref`) first and from
the pull request title second, taking the first `ABC-123` shaped match and
normalizing it without padding, so `TAC-014` resolves to `TAC-14`. Keys are
uppercase, which means a lowercase branch name such as `tac-14-fix-the-thing`
falls through to the title. A move the webhook makes is an ordinary status change
by the `git` actor, so the same transition graph and actor matrix apply, and its
timeline event body reads `pull request #<number> <action>`.

On the live host the flow is exercised end to end: a pull request opened moved
its issue to In Review with a `git` event body `pull request #<n> opened`, a
reopen after a close moved it to In Review again, and a merge moved it to Done
with `pull request #<n> closed`. A replayed signed delivery, an unknown key, and
non-PR `issues` or `push` deliveries all answered
`200 {"ok":true,"ignored":true}` and left the issue untouched.

To test locally, sign the exact bytes you send:

```sh
export GITHUB_WEBHOOK_SECRET=testsecret
body='{"action":"opened","number":7,"pull_request":{"number":7,"title":"TAC-14 fix the thing","merged":false,"head":{"ref":"tac-14-fix-the-thing"}}}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -r | cut -d' ' -f1)"
curl -sS -X POST http://127.0.0.1:4747/webhooks/github \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-hub-signature-256: $sig" \
  --data-binary "$body"
```

`node` computes the same signature when `openssl` is not at hand:

```sh
sig="sha256=$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHmac("sha256",process.env.GITHUB_WEBHOOK_SECRET).update(process.argv[1],"utf8").digest("hex"))' "$body")"
```

A delivery whose key resolves to a movable issue replies `{"ok":true}` and the
issue appears in In Review on the board. Repeating the same body replies
`{"ok":true,"ignored":true}`, because the move has already been made. For the
merge case send `"action":"closed"` at the top level with `"merged":true` inside
`pull_request`.

## Web client

`npm run build` produces `web/dist`, and `npm start` serves it on the same origin
as the API. Open `http://127.0.0.1:4747`, sign in with `CURVED_UI_TOKEN`, and the
cookie keeps the session for 30 days. The first run starts with project setup.

The client covers the core human loop:

- Board and mobile status list, with drag-to-move on desktop. Drop targets come
  from each issue's `allowedTransitions`, so the UI cannot invent an edge.
- Ready queue with claim order, in-flight agents, and human unblock.
- Issue detail with the append-only timeline, comment composer, status moves,
  field edits, label replacement, and blocking relations.
- Command palette (`Ctrl+K` or `Cmd+K`) for issue search and actions.
- Loading, empty, error, and reduced-motion states throughout.

The board and an open issue detail refresh from one `EventSource` on
`/api/events`. `issues_changed` frames are filtered by the current project id,
and the client reconnects one second after an error or close with a single-timer
guard. Window focus refresh and the manual refresh control remain; there is no
polling interval.

The palette and all screens are client-side routes under `/p/<project>`; the
server falls back to `index.html` for reloads. The theme is the fixed warm
near-black palette; there is no light mode by design.

For development, run `npm start` on 4747 and `npm run dev` on 5173. Vite proxies
`/api` to the API server, so the session cookie and JSON calls work unchanged.

## MCP server (stdio)

The MCP server speaks JSON-RPC over stdio and calls the same service layer as the
CLI. It never runs SQL itself.

Prerequisites:

1. Postgres: `docker compose up -d`.
2. Schema: `npm run migrate`.
3. An agent identity: `node src/composition/cli.ts agent add <name>` prints a
   `crv_` token once. Export it as `CURVED_AGENT_TOKEN`; only its hash is stored,
   so save it.

Start the server with `npm run mcp`, which is `node src/composition/mcp.ts`.
stdout belongs to the JSON-RPC protocol; logs go to stderr. Writing anything else
to stdout corrupts the stream.

Harness config example:

```json
{
  "mcpServers": {
    "curved": {
      "command": "node",
      "args": ["/absolute/path/to/curved/src/composition/mcp.ts"],
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
