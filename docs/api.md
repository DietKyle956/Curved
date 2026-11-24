# API and webhooks

`node src/composition/server.ts` (or `npm start`) serves the JSON API under
`/api`, the GitHub webhook at `/webhooks/github`, and the SPA for every other
path. One process owns all of it.

## Prerequisites

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
6. For passkeys, optional overrides: `CURVED_WEBAUTHN_ORIGINS` takes
   comma-separated origins and `CURVED_WEBAUTHN_RP_ID` takes the relying party
   ID. Origins default to `https://$CURVED_DOMAIN` when `CURVED_DOMAIN` is set,
   otherwise `http://localhost:4747` and `http://localhost:5173`; the RP ID
   defaults to the hostname of the first origin. Each origin must be a bare
   http/https origin, and its host must equal the RP ID or be a subdomain of it.
   A passkey is bound to the RP ID it was registered under, so changing
   `CURVED_DOMAIN` or the RP ID invalidates existing passkeys: sign in with the
   UI token and register a new one.
7. Over HTTPS only: export `COOKIE_SECURE=1` so the session and logout cookies
   also carry `Secure`.

`PORT` defaults to 4747. `COOKIE_SECURE` defaults off: the login and logout
`Set-Cookie` values keep `HttpOnly; SameSite=Lax; Path=/; Max-Age=...` and omit
`Secure`. Set `COOKIE_SECURE=1` (or `true`) when the app is served over HTTPS and
both cookies also carry `Secure`; local HTTP development and the acceptance gate
leave it unset.

## Authentication

Authentication has two lanes. A human session is either
`Authorization: Bearer <CURVED_UI_TOKEN>` (kept for deploy, health, CLI, MCP, and
acceptance) or the `curved_session` cookie minted by `POST /api/session` or a
passkey login. Sessions are opaque server-side rows: the cookie holds a
32-character base64url nonce (192 bits), only its SHA-256 is stored in
`auth_sessions`, and the row expires after 30 days, so the cookie is
`HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`. Token and passkey logins both
create a row, and `DELETE /api/session` deletes the row, so logout revokes the
session. The old deterministic `sha256(UI_TOKEN)` cookie is gone, so an existing
cookie requires a new sign-in. Any other bearer is resolved as an agent token
through the `agents` table. A bearer that is present but invalid is
`401 not_authenticated`, even alongside a valid cookie, so a stale agent token is
never silently downgraded.

Projects have no delete route. `PATCH /api/projects/:key` is the only edit path
and rejects a `key` field, because a project key never changes; `archived: true`
is the terminal lifecycle action, an archived project stays readable, and its
issues stay writable. Project edits only touch `updated_at` and never write
issue events. `PATCH /api/issues/:key` likewise rejects `project`, since an
issue's project cannot change.

Passkeys use one implicit human identity: every registered credential belongs to
that identity, there is no users table, and passkey registration or login does
not create timeline events or a new actor type. Credentials live in
`passkey_credentials`, sessions in `auth_sessions`, and single-use registration
and assertion challenges in `webauthn_challenges` (migrations `0006` and `0008`);
`@simplewebauthn/server` and `@simplewebauthn/browser` implement both flows. Each
credential is bound to one relying party ID, recorded in
`passkey_credentials.rp_id`, because WebAuthn cannot use a credential under a
different hostname; rows written before migration `0008` have no RP ID and are
inert. `GET /api/passkeys/available` answers `{ available, otherDomain }` without
auth and with `cache-control: no-store`, so the sign-in screen knows whether to
offer the passkey button and can explain that stale credentials exist;
`GET /api/passkeys` annotates each row with `rpId` and `usable`. Login options
offer only current-domain credentials and add `hints: ["client-device"]`; when
none exist the route fails with "no passkey is registered for this domain", and
finishing with an other-domain credential is `401 not_authenticated`.
Registration stores the current RP ID and excludes only usable ids. After a
domain change a passkey from the old name cannot be used: sign in with the UI
token, add a passkey in the passkeys dialog, then delete the old-domain row,
which the dialog tags "Different domain". The remaining passkey routes are
human-only and accept either the UI bearer or the session cookie; only the login
options and completion pair is unauthenticated.

`GET /api/events` is the one exception: it authenticates by the `curved_session`
cookie only and ignores `Authorization`, because `EventSource` cannot set request
headers. A request with no cookie, including a bearer-only request, is
`401 not_authenticated` JSON.

`POST /api/session`, `POST /api/session/passkey/options`, and
`POST /api/session/passkey` are the unauthenticated `/api` routes; every other
route, including `GET /api/projects`, rejects requests without valid credentials
with `401 not_authenticated`.

## Realtime

Migration `0005` adds `notify_issue_change()`, which fires on
`after insert` and `after update` of `issues` and on `after insert` of
`issue_events`, calling `pg_notify('issues_changed', project_id::text)` for the
owning project. `GET /api/events` is a cookie-authenticated `text/event-stream`
that sends `ready` once the subscription exists, one `issues_changed` frame per
notification carrying the project id as `data`, and a `ping` every 25 seconds.
One lazily opened shared `pg.Client` per app runs a single `LISTEN
issues_changed` and fans notifications out to that app's subscribers.

## Labels and relations

Labels are per project: a label name is unique within its project, trimmed, 1 to
50 characters, and reused by every issue in that project that carries it. Setting
an issue's labels replaces its whole set, and an empty set clears it. Relations
are directed and only express blocking: one issue blocks another. Both are
append-only timeline events with JSON bodies, a `labels` event carrying the sorted
label names and a `relation` event carrying the blocking and blocked keys. Every
issue payload carries `labels` and `relations: { blocks, blockedBy }`, where
`blocks` holds the keys this issue blocks and `blockedBy` the keys blocking it.
`ready` and `claim` exclude an issue while any issue blocking it is not `done`.

## Routes

| Method | Path | Auth | Result |
|---|---|---|---|
| `GET` | `/api/me` | human or agent | `{ actor }` |
| `POST` | `/api/session` | UI token in the `{ token }` body | Sets the cookie, returns `{ actor }` |
| `DELETE` | `/api/session` | human or agent | `204`, deletes the session row, clears the cookie |
| `GET` | `/api/passkeys/available` | none | `{ available, otherDomain }`; `cache-control: no-store` |
| `GET` | `/api/passkeys` | human only | `{ passkeys }` |
| `POST` | `/api/passkeys/options` | human only | registration options |
| `POST` | `/api/passkeys` | human only | `201 { passkey }` |
| `DELETE` | `/api/passkeys/:id` | human only | `204` |
| `POST` | `/api/session/passkey/options` | none | login options |
| `POST` | `/api/session/passkey` | none | `{ actor }` plus the session cookie |
| `GET` | `/api/projects` | human or agent | `{ projects }` with progress; archived rows are excluded unless `?includeArchived=true` |
| `POST` | `/api/projects` | human only | `201 { project }` |
| `GET` | `/api/projects/:key` | human or agent | `{ project }` with progress |
| `PATCH` | `/api/projects/:key` | human only | `{ project }`; `name`, `summary`, `description`, `status`, `priority`, `startDate`, `targetDate`, `archived`; `null` clears priority or a date, and a `key` field is `validation` |
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

## Errors and static files

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
shares no credential with it: it reads no cookie and no bearer header and
authenticates only as a GitHub delivery, accepted only when the
`x-hub-signature-256` header equals the HMAC-SHA256 of the raw request body keyed
by `GITHUB_WEBHOOK_SECRET`. The raw body is read and checked before anything is
parsed, and it is rejected above 1 MiB. A missing or mismatched signature is
`401 not_authenticated`, and the route responds `{"ok":true}` when it moved an
issue and `{"ok":true,"ignored":true}` otherwise, so GitHub never retries.

The live repository hook posts to
`https://curv3d.duckdns.org/webhooks/github` (hook id 715784553, event
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

The host verifier proves the deployed boundary the same way: an unsigned
delivery is `401`, and a correctly signed unknown-key delivery is
`200 {"ok":true,"ignored":true}`.

The `x-github-event` header must read `pull_request`; deliveries carrying any
other event value are ignored. `GITHUB_WEBHOOK_SECRET` must be exported for the
server process; until it is, the route answers `503 webhook_not_configured`. A
missing or wrong signature is `401 not_authenticated`, and a body that is not
valid JSON is `400 validation`.

Only `pull_request` events act, and the payload's `action` with the
`pull_request` object's `draft` and `merged` decide the move. A non-draft
`opened`, a non-draft `reopened`, and `ready_for_review` move the issue to In
Review; a draft is ignored until it is ready; `closed` moves it to Done only
when the pull request merged. `closed` without a merge, every other action, and
every other event are acknowledged with `200 {"ok":true,"ignored":true}` so
GitHub does not retry the delivery. The same ignored response covers an unknown
issue key, a key whose issue cannot take the move, and a replay of a move
already made.

The issue key is read case-insensitively from the pull request branch
(`head.ref`) first and from the pull request title second, taking the first
`ABC-123` shaped match and normalizing it without padding, so `TAC-014` resolves
to `TAC-14` and `tac-14-fix-the-thing` resolves TAC-14. The first valid match
comes from the branch and then the title, and numbers below 1 are not keys. A
move the webhook makes is an ordinary status change by the `git` actor, so the
same transition graph and actor matrix apply, and its timeline event body reads
`pull request #<number> <action>`.

### Pull request workflow

1. `curved claim <PROJECT>` (or a human move) puts the issue in In Progress.
2. `curved git-branch <KEY>` prints `KEY-title-slug`; push it.
3. `gh pr create --base main --title "<KEY> <title>"`; the `opened` delivery
   moves the issue to In Review. A draft PR is ignored until `ready_for_review`.
4. `verify` runs on the PR. Merge; the `closed` delivery moves the issue to Done
   and the push to `main` deploys.

A `todo` issue is ignored by design: the claim or human move comes first.

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
