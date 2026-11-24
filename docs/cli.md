# CLI

The CLI is the shell entry point `node src/composition/cli.ts`, also available as
`npm run cli`. Commands run as the human actor unless noted; agent commands read
`CURVED_AGENT_TOKEN` and never fall back to the human actor. Errors print
`<code>: <message>` and exit 1.

## Commands

- `node src/composition/cli.ts project add <KEY> <name...> [--summary <text>]
  [--description <text>] [--status <status>] [--priority <1-4>] [--start <date>]
  [--target <date>]` - create a project; status defaults to `planned`.
- `node src/composition/cli.ts project list [--all]` - list active projects, or
  all with `--all`; columns are key, name, status, priority (or `-`),
  done/total progress, target date (or `-`), and `no`/`yes` for archived.
- `node src/composition/cli.ts project show <KEY>` - print the project with its
  summary, description, dates, progress, and archive state; `--json` prints the
  project with progress.
- `node src/composition/cli.ts project edit <KEY> [--name <name>]
  [--summary <text>] [--description <text>] [--status <status>]
  [--priority <1-4|none>] [--start <date|none>] [--target <date|none>]` - edit a
  project; `none` clears the priority or a date.
- `node src/composition/cli.ts project archive <KEY>` - archive a project; it
  stays readable and its issues stay writable. There is no delete.
- `node src/composition/cli.ts project restore <KEY>` - restore an archived
  project.
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
