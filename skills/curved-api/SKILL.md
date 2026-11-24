---
name: curved-api
description: >-
  Call the Curved HTTP API from an agent or integration. Use when a prompt
  mentions Curved endpoints, curl, an agent crv_ bearer token, GET /api/ready,
  POST /api/claims/next, issue transitions, comments, SSE /api/events, or the
  { error: { code, message } } response shape. Covers authentication, the
  tracker routes and payloads, human-only routes, HTTP status mapping, and live
  updates. For MCP use curved-agent; for shell use curved-cli.
metadata:
  source: https://github.com/DietKyle956/Curved
---

# Curved HTTP API

The HTTP API serves the SPA, the API, and the SSE stream from one process. It is
the remote option when neither MCP nor the CLI can reach Postgres. There is no
CORS: browser clients run on the same origin.

## Curved's rules

- Statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`.
- Legal edges: `backlog -> todo`; `todo -> backlog | in_progress`;
  `in_progress -> todo | in_review`; `in_review -> done | in_progress`;
  `done -> todo`.
- Agents may take only `todo -> in_progress` (claim an unclaimed issue),
  `in_progress -> in_review`, and `in_progress -> todo` on their own claim.
  Every other edge belongs to a human or to git.
- One active claim per agent, globally: an issue in `in_progress` or
  `in_review` claimed by you blocks a second claim with `agent_busy` naming
  that key.
- Claiming sets `claimed_by`; review keeps it. Leaving `in_progress` or
  `in_review` for `todo` or `backlog` clears it. Blocking is a reason on a
  `todo` issue, not a status, and blocked issues never appear in the ready
  queue.
- Agent-only actions: claim, review, release, block. Human-only actions:
  unblock, arbitrary moves, issue edits, labels, relations, project
  create/edit/archive. Git-only edge: `in_review -> done` on a merged pull
  request.

## Connect

- `CURVED_BASE_URL` is the operator's base URL without a trailing slash, for
  example `https://<your-curved-host>`. `CURVED_AGENT_TOKEN` is a `crv_` token
  minted with `curved agent add <name>`.
- Send `Authorization: Bearer <token>`. The UI token authenticates a human;
  any other bearer is looked up as an agent token; an invalid bearer is `401`
  even when a valid session cookie is also present.
- Mutating requests with a body must send `Content-Type: application/json`. An
  empty body reads as `{}`.
- `GET /api/me` returns
  `{ "actor": { "type": "human" | "agent", "name": string | null } }`.

## Work loop over HTTP

All examples use:

```sh
export CURVED_BASE_URL='https://<your-curved-host>'
export CURVED_AGENT_TOKEN='crv_...'
AUTH="Authorization: Bearer $CURVED_AGENT_TOKEN"
```

1. Ready:

   ```sh
   curl -sS "$CURVED_BASE_URL/api/ready" -H "$AUTH"
   ```

   Optional `?project=KEY`. Returns `{ ready, busy }` with the same selection
   rules as `curved-agent`.

2. Claim:

   ```sh
   curl -sS -X POST "$CURVED_BASE_URL/api/claims/next" \
     -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
   ```

   Optional `?project=KEY`. Returns `201 { issue }`. Errors:
   `409 agent_busy`, `409 no_ready_issue`.

3. Read:

   ```sh
   curl -sS "$CURVED_BASE_URL/api/issues/KEY" -H "$AUTH"
   ```

   Returns `{ issue, events, children }`.

4. Comment:

   ```sh
   curl -sS -X POST "$CURVED_BASE_URL/api/issues/KEY/comments" \
     -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"body":"Implemented and tested."}'
   ```

   Returns `201 { event }`.

5. Review:

   ```sh
   curl -sS -X POST "$CURVED_BASE_URL/api/issues/KEY/transition" \
     -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"to":"in_review","body":"Summary of the change and its verification."}'
   ```

   Returns `{ issue }`. This records a `status` event. MCP
   `submit_for_review` records a `review_submitted` event instead, so the two
   transports differ only in event kind.

6. Block:

   ```sh
   curl -sS -X POST "$CURVED_BASE_URL/api/issues/KEY/block" \
     -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"reason":"Waiting for the staging credentials."}'
   ```

   Agent only. Reason 1..2000. The issue returns to `todo` and the claim
   clears.

7. Release:

   ```sh
   curl -sS -X POST "$CURVED_BASE_URL/api/issues/KEY/release" \
     -H "$AUTH" -H 'Content-Type: application/json' -d '{}'
   ```

   Agent only, from `in_progress`. Returns `{ issue }`.

8. Create:

   ```sh
   curl -sS -X POST "$CURVED_BASE_URL/api/issues" \
     -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"project":"KEY","title":"Follow-up","priority":2}'
   ```

   Returns `201 { issue }`. Defaults: status `backlog`, priority 3, no parent.
   A parent must be in the same project.

## Route table

|Method and path|Actor|Body and result|
|---|---|---|
|`GET /api/me`|human or agent|`{ actor }`|
|`GET /api/projects`|human or agent|`{ projects }` with progress; `?includeArchived=true` adds archived rows|
|`POST /api/projects`|human|`{ key, name, summary?, description?, status?, priority?, startDate?, targetDate? }` -> `201 { project }`|
|`GET /api/projects/:key`|human or agent|`{ project }` with progress|
|`PATCH /api/projects/:key`|human|`{ name?, summary?, description?, status?, priority?, startDate?, targetDate?, archived? }` -> `{ project }`; `null` clears priority or a date; `key` is rejected|
|`GET /api/issues`|human or agent|`{ issues }`; filters `?project=` and `?status=`|
|`POST /api/issues`|human or agent|`{ project, title, description?, priority?, status?, parent? }` -> `201 { issue }`|
|`GET /api/issues/:key`|human or agent|`{ issue, events, children }`|
|`PATCH /api/issues/:key`|human|`{ title?, description?, priority? }` -> `{ issue }`; `project` is rejected|
|`POST /api/issues/:key/transition`|human or agent|`{ to, body? }` -> `{ issue }`|
|`POST /api/issues/:key/comments`|human or agent|`{ body }` -> `201 { event }`|
|`POST /api/issues/:key/block`|agent|`{ reason }` -> `{ issue }`|
|`POST /api/issues/:key/unblock`|human|`{}` -> `{ issue }`|
|`POST /api/issues/:key/release`|agent|`{}` -> `{ issue }`|
|`POST /api/issues/:key/labels`|human|`{ labels }` replaces the set -> `{ issue }`|
|`POST /api/issues/:key/relations`|human|`{ blocking }`; `:key` is the blocked issue -> `{ issue }`|
|`DELETE /api/issues/:key/relations/:blocking`|human|`{ issue }`|
|`GET /api/ready`|human or agent|`{ ready, busy }`; `?project=`|
|`POST /api/claims/next`|agent|`201 { issue }`; `?project=`|
|`GET /api/events`|session cookie only|`text/event-stream`|

`/api/session` and `/api/passkeys/*` exist for human sign-in and are not needed
when using a bearer token.

## Payloads

- Issue fields: `id`, `key`, `projectId`, `projectKey`, `number`, `title`,
  `description`, `status`, `allowedTransitions`, `priority`, `parentId`,
  `parentKey`, `blockedReason`, `claimedBy`, `labels`, `relations` with
  `blocks` and `blockedBy`, `createdAt`, `updatedAt`. `allowedTransitions` is
  computed for the caller; use it.
- Event fields: `id`, `issueId`, `kind`, `actorType`, `fromStatus`, `toStatus`,
  `body`, `createdAt`. Kinds: `created`, `status`, `comment`, `claim`,
  `release`, `review_submitted`, `blocked`, `unblocked`, `labels`, `relation`.
- Project fields: `id`, `key`, `name`, `summary`, `description`, `status`,
  `priority`, `startDate`, `targetDate`, `archivedAt`, `nextNumber`,
  `createdAt`, `updatedAt`, plus `progress` `{ total, done, byStatus }`.
- Ready queue: `{ ready: Issue[], busy: string | null }`.

## Errors

The body is `{ "error": { "code": "...", "message": "..." } }`.

|HTTP|Code|
|---|---|
|400|`validation`|
|401|`not_authenticated`|
|403|`forbidden_transition`|
|404|`not_found`|
|409|`illegal_transition`, `agent_busy`, `no_ready_issue`, `duplicate`|
|503|`webhook_not_configured`|
|500|`internal`|

## Live updates (SSE)

- `GET /api/events` authenticates by the `curved_session` cookie only, because
  `EventSource` cannot set headers. A bearer-only request is `401`.
- Events: `ready` on connect; `issues_changed` with the numeric project id as
  `data`; `ping` every 25 seconds. Reconnect after 1 second.
- Filter `issues_changed` by project id. There is no CORS.

## Ask a human instead

Ask a human to use the routes that reject agents: `PATCH` on a project or
issue, labels, relations, unblock, and any transition outside the agent matrix.
Surface the issue key, the action, and the reason.

## Completion check

- The bearer is set and the correct token lane is used.
- Mutating requests send `Content-Type: application/json`.
- The next status comes from `allowedTransitions`, not a guess.
- Errors are read from `{ error: { code, message } }`, not from a bare status.
