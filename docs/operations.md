# Operations

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

[Container image](#container-image) covers the artifact; this section covers the
stack that runs it. `deploy/docker-compose.yml` is the production stack under the
Compose project `curved-prod`, with three services:

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
also carries optional host-port and image overrides, plus commented
`CURVED_WEBAUTHN_ORIGINS` and `CURVED_WEBAUTHN_RP_ID` overrides. Passkey origins
default to `https://$CURVED_DOMAIN` and the RP ID to that hostname, so an
existing `deploy/.env` needs no new key. The file is gitignored, so secrets stay
out of the repository.

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

The live host runs this way at `https://curv3d.duckdns.org`. The name is a
DNS-only DuckDNS A record for the reserved IPv4 `129.213.209.162`, so the ACME
HTTP and TLS-ALPN challenges reach Caddy directly. Its certificate is issued by
Let's Encrypt for `curv3d.duckdns.org` (issuer `YE2`, valid to Feb 21 2027), and
the container sees
`ACME_EMAIL=admin@sslip.io`, `CURVED_DOMAIN=curv3d.duckdns.org`, and
`CURVED_HSTS_MAX_AGE=31536000`. Through the public edge the SPA and JS assets,
the authenticated API, and the SSE stream answer over verified TLS, and the
API's unauthenticated `GET /api/projects` stays a 401.

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
`127.0.0.1:55432` on the host, so an agent on another machine reaches it through
`deploy/agent-tunnel.sh`, which forwards local `127.0.0.1:55433` to that host
loopback port; the stack publishes no database port, and
`deploy/provisioning.md` section 19 has the full agent sequence. `down` without
`-v` stops and removes the containers while keeping the volumes.

**`docker compose -f deploy/docker-compose.yml down -v` deletes the Postgres and
Caddy volumes: every project, issue, event, and the database itself, plus Caddy's
data volume with the internal CA and every ACME account and certificate. Never
run it on the server.** A backup set taken before the command is the only
recovery: `deploy/restore.sh postgres` and `deploy/restore.sh caddy` (see
[Backups and restore](#backups-and-restore)).

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
volume, a 100 GB block volume, and one reserved public IPv4. The live name is a
DNS-only DuckDNS A record for that reserved IP (`curv3d.duckdns.org`); with your
own domain, use a DNS-only (never proxied) `A` record so the origin stays
directly reachable. The host serves the public HTTPS stack: Caddy obtains a
Let's Encrypt certificate for `curv3d.duckdns.org` through ACME, redirects HTTP
to HTTPS, sends HSTS for a year, compresses responses outside the SSE route, and
flushes `/api/events` without buffering. The DuckDNS record resolves straight to
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
7 days and unused images older than 30 days. `curved-backup.timer` takes the
nightly Postgres and Caddy backup at 03:17 into `/srv/curved/backups`.
`curved-keepalive.timer` runs `/usr/local/bin/curved-keepalive` hourly for ten
minutes at idle priority, which keeps Oracle's CPU 95th percentile above its
20% idle-reclaim threshold without a sustained average. The 50 GB
boot volume holds the OS only.

Two commands do the work, both as root on the server. Run the first from the
provisioning clone (`~/curved-provision`):

```sh
sudo bash deploy/bootstrap-host.sh --key ~/.ssh/id_ed25519.pub \
  --domain <domain> --data-device /dev/sdb
sudo bash /srv/curved/checkout/deploy/verify-host.sh --domain <domain>
```

`deploy/bootstrap-host.sh` is idempotent: it installs Docker, creates the key-only
`deploy` account and the sshd drop-in, prepares and mounts the data device,
clones the repository, writes `deploy/.env`, creates `/srv/curved/backups` with
the daily backup units, installs the hourly keepalive units, starts the Compose
stack, and takes one initial nightly set.
`deploy/verify-host.sh` is read-only and prints `PASS` or `FAIL` for the OS, the
`deploy` account, sshd policy, the data mount, storage accounting,
`docker-root`, `docker-config`, `docker-mount-dependency`, `docker-prune-timer`,
`keepalive-timer`, `backup-dir`, `backup-timer`, `backup-freshness`,
`backup-integrity`, the environment file, the checkout, the TCP and UDP
listeners, the stack health,
`tls-certificate` (a verified HTTPS response to the API), `http-redirect`
(HTTP to HTTPS), `hsts` (the configured max-age), `compression` (a compressed
asset), `caddy-issuance` (an ACME certificate obtained for the domain in the
Caddy log), `https-api` (200 authenticated, 401 unauthenticated), and `webhook`
(an unsigned delivery is 401 and a correctly signed unknown-key delivery is
200). The bootstrap ends with `bootstrap-host: ok` and the verifier with
`verify-host: ok`; any other ending is a failure. A reboot proof is in
`deploy/provisioning.md` section 9.4.

`npm run smoke:provision` is the repository-side proof: it runs the bootstrap
and verifier inside a disposable container against Ubuntu 24.04 stubs and proves
the Docker data root, mount gate, log rotation, prune timer, the hourly
keepalive unit and script, the 0700 backup directory with its daily units and
one initial nightly set, the public-mode environment generated by
`--acme-email`, the verifier's internal and public happy paths including the
keepalive and four backup checks, and their negatives, so a change to either
script is caught without an OCI tenancy. The OCI console steps and the live host
checks are operator-executed.

### Agent access to the deployed database

Agents reach the deployed Postgres through an SSH tunnel, never a public port.
The host has no Node toolchain, so the agent identity is minted once through the
app image, from `/srv/curved/checkout` on the host:

```sh
docker compose -p curved-prod --env-file deploy/.env \
  -f deploy/docker-compose.yml run --rm --no-deps -T app \
  node src/composition/cli.ts agent add <name>
```

That prints one `crv_` token; hand it over once and keep it as
`CURVED_AGENT_TOKEN`, because only its hash is stored. On the agent machine,
from a checkout at the deployed commit:

```sh
./deploy/agent-preflight.sh --host 129.213.209.162
./deploy/agent-tunnel.sh --host 129.213.209.162
export DATABASE_URL=postgres://curved:<password>@127.0.0.1:55433/curved
export CURVED_AGENT_TOKEN=crv_...
```

`deploy/agent-preflight.sh` fails unless the checkout matches the revision
recorded in `/srv/curved/release-state`, and `deploy/agent-tunnel.sh` forwards
local `127.0.0.1:55433` to the host's loopback `55432`, leaving `55432` to local
development. The `deploy` account is in the `docker` group and is
root-equivalent, so treat its key as a root key. `deploy/provisioning.md`
section 19 has the full sequence.

### Backups and restore

`deploy/backup.sh` writes timestamped sets under `/srv/curved/backups`: a
custom-format Postgres dump plus, when Caddy runs, tar archives of the Caddy
data and config volumes. Each set holds a `manifest.txt` and a `SHA256SUMS`, its
files are mode 0600 in a 0700 tree, and `<kind>/latest` points at the newest set
of that kind. Bootstrap creates the directory, installs `curved-backup.timer`
(daily at 03:17) and `curved-backup.service`, and takes one set at the end of
the run. Each kind keeps the newest 7 sets; `--keep N` and `--no-prune` change
that, and `--output-dir`, `--tag`, `--label`, `--env-file`, `--compose-file`,
and `--project` cover the rest. `deploy/release.sh` takes a `pre-deploy` set
before it builds or migrates, and a failed backup aborts the release before any
database, container, image, or state change.

```sh
cd /srv/curved/checkout
./deploy/backup.sh nightly
./deploy/backup.sh pre-deploy --tag "$(git rev-parse --short HEAD)"
./deploy/restore.sh postgres /srv/curved/backups/pre-deploy/latest --yes
./deploy/restore.sh caddy /srv/curved/backups/nightly/latest --yes
```

A production restore verifies `SHA256SUMS` first, stops `app`, replays the dump
with `pg_restore --clean --if-exists`, and leaves the app stopped so the data is
checked before anything serves; bring it back with
`./deploy/release.sh rollback <tag>`. `--database NAME` restores into a separate
database as a drill with the app left running, `--yes` is mandatory either way,
and a Caddy restore needs a set whose manifest records `caddy=archived`. The
sets live on the same data volume as the database, so they cover a bad
migration, a dropped table, or an accidental `down -v`, but not host or volume
loss: copy a set off the host for that case. The full order, including a Caddy
restore and a host rebuild, is `deploy/provisioning.md` section 17.
`verify-host` adds `backup-dir`, `backup-timer`, `backup-freshness`, and
`backup-integrity`, and `npm run smoke:backup` is the repository-side gate.

## Releasing

A push to `main` deploys. `.github/workflows/verify.yml` runs `verify`, and a
second job, `deploy`, declares `needs: verify` and
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
2. Take a pre-deploy backup with `./deploy/backup.sh pre-deploy --tag
   curved:<short>` into `/srv/curved/backups/pre-deploy/<timestamp>`. A failure
   exits 1 with `release: error: the pre-deploy backup failed; no migration,
   container, image tag, or state change happened`, before anything is built.
3. Build `app` with `CURVED_IMAGE=curved:<short>`.
4. Run `node src/composition/migrate.ts` once in a throwaway container with
   `run --rm --no-deps -T app`. A failing migration exits the script immediately
   and prints that the previous app is still serving; the app and Caddy are not
   recreated, nothing is retagged, and no release state is written.
5. Recreate `app` alone with the new image, `--no-deps --wait
   --wait-timeout 600`.
6. Recreate `caddy` alone.
7. Probe `https://$CURVED_DOMAIN/api/projects` with the UI bearer token, a
   ten-second request timeout, and 30 attempts two seconds apart. With an empty
   `ACME_EMAIL` the probe extracts Caddy's internal root CA from
   `/data/caddy/pki/authorities/local/root.crt` and passes it as `--cacert`.
   With a non-empty `ACME_EMAIL` it verifies the public certificate against the
   system trust and requires a `Strict-Transport-Security` header, whose max-age
   must equal `CURVED_HSTS_MAX_AGE` when that is set. The token never reaches
   the output.
8. After a successful probe, tag `curved:<short>` as `curved:latest`, write the
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
and updates the state file on success. It takes no backup of its own. It also
prints that a migration which is not backward compatible needs a database
restore instead of an image rollback: the newer schema stays in place when the
older image returns. In that case restore the pre-deploy set the failed release
wrote, then roll back the image:

```sh
./deploy/restore.sh postgres /srv/curved/backups/pre-deploy/latest --yes
./deploy/release.sh rollback <tag>
```

The restore stops `app` and leaves it stopped, so the rollback is what brings it
back. `deploy/provisioning.md` section 14.4 has the full order, and section 17
documents the set layout, the manual commands, the drill restore, and the Caddy
restore.

`npm run smoke:release` runs `bash scripts/release-smoke.sh`, the gate for this
path. It drives the script against stubbed `git`, `docker`, `curl`, and `sleep`
binaries in a temporary `PATH`, with no Docker, database, or network, and
asserts the ordering, the migration failure path, the first-deploy skip, the
second-deploy probe failure, the public probe's HSTS requirement (a matching
max-age passes, a missing header or a mismatched max-age is fatal and leaves
`curved:latest` and the state file untouched), rollback, and that the bearer
token never appears in the output.

`npm run smoke:agent` is the agent tunnel and parity gate for
`deploy/agent-tunnel.sh` and `deploy/agent-preflight.sh`. It drives both scripts
against stubbed `ssh`, `git`, and `cat` binaries, with no Docker and no network,
and asserts the loopback forward on local 55433, the refusal of local 55432 and
of equal local and remote ports, the usage exits, and the matching, mismatched,
and missing deployed-commit paths.

### Rotate the UI token

The UI bearer token is the `CURVED_UI_TOKEN` line in
`/srv/curved/checkout/deploy/.env` on the host. Only the GitHub deploy key can
reach the host over SSH, so a local `ssh deploy@...` is denied; the recovery
path when the deployed token is unknown or lost is the manual
`.github/workflows/rotate-ui-token.yml` workflow. Update the repository secret,
then dispatch the workflow and wait for the green run:

```sh
gh secret set CURVED_UI_TOKEN < /path/to/new-token
gh workflow run rotate-ui-token.yml
```

The job validates the `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_HOST`,
and `CURVED_UI_TOKEN` secrets, writes the key and known_hosts under
`$RUNNER_TEMP` with mode 600, and pipes the token over stdin, never argv and
never a log line. On the host it atomically rewrites the `CURVED_UI_TOKEN` line
in the mode-600 env file, backing it up and restoring it along with a release
re-run if the release fails, then runs `./deploy/release.sh` and proves the new
value with `POST https://$CURVED_DOMAIN/api/session` returning 200. Existing
browser sessions stay valid; only new token logins use the new value.

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
