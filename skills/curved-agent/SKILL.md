---
name: curved-agent
description: >-
  Operate as a worker agent in Curved, an agent-first issue tracker. Use when
  asked to work a Curved issue, list the ready queue, claim the next issue,
  comment, submit for review, block or release a claim, or when a prompt names
  the Curved MCP tools (list_ready, claim_next, get_issue, create_issue,
  comment, submit_for_review, mark_blocked, release_claim). Covers the
  one-active-claim rule, the status graph and actor permissions, MCP setup, and
  the claim -> work -> review loop. Use curved-cli for shell commands and
  curved-api for HTTP integration.
metadata:
  source: https://github.com/DietKyle956/Curved
---

# Curved agent workflow

Curved is an agent-first issue tracker. It enforces the one-active-claim rule,
the status graph, and the actor matrix in the service layer and in Postgres, so
an agent cannot talk its way around them. The timeline (`issue_events`) is
append-only; comments are timeline events, not editable rows.

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

The agent path is MCP over stdio. It needs direct Postgres access
(`DATABASE_URL`) and `CURVED_AGENT_TOKEN`. Ask the operator for both values;
the token is minted once with `curved agent add <name>` (or
`node src/composition/cli.ts agent add <name>` from a checkout) and only its
SHA-256 is stored.

MCP client config, with placeholders:

```json
{
  "mcpServers": {
    "curved": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/path/to/curved",
      "env": {
        "DATABASE_URL": "postgres://<user>:<password>@<host>:<port>/<database>",
        "CURVED_AGENT_TOKEN": "crv_..."
      }
    }
  }
}
```

The file holds secrets: keep it mode 600 or let the runtime inject both
variables. `npm run mcp` and `node src/composition/mcp.ts` are the same entry
point. stdout belongs to JSON-RPC; logs go to stderr.

If only HTTP is reachable, use the `curved-api` skill. If only a shell is
reachable, use `curved-cli`.

Health check: call `list_ready`. A `not_authenticated` text result means
`CURVED_AGENT_TOKEN` is missing, empty, or not a `crv_` agent token.

## The loop

1. Call `list_ready` with an optional `{ "project": "KEY" }`. The result is
   `{ "ready": Issue[], "busy": string | null }`. `busy` names your active
   issue across all projects, even when filtered to one project. If `busy` is
   not null, finish or release that issue first.
2. Call `claim_next` with an optional `{ "project": "KEY" }`. It picks the
   ready issue with the lowest priority number (1 first), then the lowest
   issue number, then the lowest key, using `for update skip locked`. It skips
   issues that are not `todo`, issues with a blocked reason, and issues whose
   `blockedBy` relation is not `done`. It returns
   `{ issue, events, children }`. Done when the issue is `in_progress`,
   `claimed_by` is your agent name, and a `claim` event exists.
   - `agent_busy` means you already hold an active issue; the message names it.
   - `no_ready_issue` means nothing is claimable; stop rather than invent work.
3. Call `get_issue` with `{ "key": "KEY" }` to read the full timeline, labels,
   relations, parent, children, and `allowedTransitions`. Use
   `allowedTransitions` instead of guessing whether a move is legal.
4. Do the work. Call `comment` with
   `{ "key": "KEY", "body": "..." }` for material progress, decisions, and
   verification evidence; the body is trimmed and must not be empty. Comments
   append to the timeline, never rewrite it.
5. Finish with `submit_for_review` `{ "key": "KEY", "summary": "..." }`. The
   summary is trimmed, must not be empty, and becomes the `review_submitted`
   event body. Done when the issue is `in_review` and the event body carries
   the summary. The claim stays on the issue.
6. If blocked, call `mark_blocked` `{ "key": "KEY", "reason": "..." }`. The
   reason is trimmed to 1..2000 characters. The issue returns to `todo`, the
   claim is cleared, and a `blocked` event records the reason. Only a human can
   unblock. Done when the issue is `todo`, `claimed_by` is null, and the
   `blocked` event body is the reason.
7. If abandoning an unstarted claim, call `release_claim` `{ "key": "KEY" }`
   while the issue is `in_progress`. It returns the issue to `todo` and clears
   the claim. It fails from `in_review`.
8. Create follow-up issues with `create_issue`
   `{ "project": "KEY", "title": "...", "description": "...", "priority":
   1-4, "parent": "KEY" }`. Title is trimmed to 1..500, priority defaults to
   3, and a parent must be in the same project. MCP cannot set status, so a
   new issue starts in `backlog`; a human moves it to `todo` before it becomes
   claimable.

## MCP tools

|Tool|Input|Result and notes|
|---|---|---|
|`list_ready`|`{ project?: string }`|`{ ready, busy }`. `busy` is your active key or null.|
|`claim_next`|`{ project?: string }`|`{ issue, events, children }`. Errors: `agent_busy`, `no_ready_issue`.|
|`get_issue`|`{ key: string }`|`{ issue, events, children }`.|
|`create_issue`|`{ project, title, description?, priority?, parent? }`|Issue. Defaults: status `backlog`, priority 3.|
|`comment`|`{ key, body }`|The appended event; `body` must not be empty.|
|`submit_for_review`|`{ key, summary }`|Issue in `in_review`; summary must not be empty.|
|`mark_blocked`|`{ key, reason }`|Issue in `todo`; claim cleared; reason 1..2000.|
|`release_claim`|`{ key }`|Issue in `todo`; claim cleared; only from `in_progress`.|

A successful result is pretty-printed JSON in one text content block. A service
error is `<code>: <message>` with `isError: true`. Invalid input fails zod
validation before the handler runs and comes back as an input validation error.

## Pull requests

- `curved git-branch <KEY>` prints `<KEY>-<slug>`; the branch may also be named
  manually as long as it contains the key. The PR title starts with the issue
  key.
- Claim before opening the PR. The webhook ignores an issue that is not already
  `in_progress`, so the workflow is claim -> open PR.
- Non-draft `pull_request` `opened`, `reopened`, and `ready_for_review` move
  the issue to `in_review` as actor `git` with event body
  `pull request #<n> <action>`. A merged `closed` moves it to `done` with
  `pull request #<n> closed`. A closed unmerged PR is ignored.
- Draft PRs are ignored until `ready_for_review`.

## Ask a human instead

Surface the issue key, the action, and the reason. Ask a human to:

- unblock a blocked issue;
- move `in_review -> done` without a merge;
- reopen `in_review -> in_progress`;
- edit an issue's title, description, or priority;
- set labels or add or remove relations;
- create, edit, archive, or restore projects.

An agent must not use the CLI's default human actor or `--actor human` to take
these paths.

## Completion check

- One active claim, and it is the issue you are working.
- Evidence and decisions are in comments.
- The issue status matches the work: `in_review` after review, `todo` after
  block or release.
- The review summary names the change and its verification.
- Follow-up work is created as issues, not left in chat.
- No SQL was run and no table was touched.
