/**
 * The single source of truth for CLI help: the top-level usage block and the
 * per-command help printed by `--help`, `-h`, and `help <command>...`.
 *
 * Keep this file in sync with the parsers in `cli.ts`; any flag a parser
 * accepts belongs in that command's `options`, and `docs/cli.md` documents the
 * same surface for humans.
 */

export const DOCS_PATH = "docs/cli.md";

/** A positional argument of one command. */
export interface CommandArgument {
  /** Bare name without brackets, e.g. `KEY` or `name...`. */
  name: string;
  required: boolean;
  summary: string;
}

/** A flag of one command, excluding the global options added to every command. */
export interface CommandOption {
  flag: string;
  /** Rendered value placeholder, e.g. `<text>`; omitted for boolean flags. */
  value?: string;
  summary: string;
}

/** Help for one command path, such as `issue move`. */
export interface CommandHelp {
  /** Path words; empty for the root command. */
  path: readonly string[];
  /** One-line summary used in the top-level command list. */
  summary: string;
  /** Synopsis after `curved `, e.g. `issue move <KEY> <status>`. */
  synopsis: string;
  description?: string;
  arguments?: readonly CommandArgument[];
  options?: readonly CommandOption[];
}

const GLOBAL_OPTIONS: readonly CommandOption[] = [
  { flag: "--json", summary: "Print machine-readable JSON on stdout" },
  { flag: "-h, --help", summary: "Print this command's help and exit" },
];

/** The description column of the top-level command list. */
const SUMMARY_COLUMN = 30;

/** Every command, ordered as the top-level usage lists them. */
export const COMMANDS: readonly CommandHelp[] = [
  {
    path: [],
    summary: "Show the top-level usage",
    synopsis: "<command> [options]",
    description:
      "Run `curved <command> --help` for a command's synopsis, arguments, and flags.",
  },
  {
    path: ["migrate"],
    summary: "Apply pending database migrations",
    synopsis: "migrate",
    description: "Applies every pending migration and prints the applied names.",
  },
  {
    path: ["project"],
    summary: "Create, list, show, and edit projects",
    synopsis: "project <subcommand>",
    description:
      "Manage projects. Projects are archived, never deleted, and their key never changes.",
  },
  {
    path: ["project", "add"],
    summary: "Create a project",
    synopsis:
      "project add <KEY> <name...> [--summary <text>] [--description <text>] [--status <status>] [--priority <1-4>] [--start <date>] [--target <date>]",
    description: "Creates a project; the status defaults to `planned`.",
    arguments: [
      {
        name: "KEY",
        required: true,
        summary: "Project key: upper-case letters and digits, 2 to 10 characters",
      },
      {
        name: "name...",
        required: true,
        summary: "Project name; the remaining words are joined with spaces",
      },
    ],
    options: [
      { flag: "--summary", value: "<text>", summary: "Set the summary" },
      { flag: "--description", value: "<text>", summary: "Set the description" },
      { flag: "--status", value: "<status>", summary: "Set the status" },
      { flag: "--priority", value: "<1-4>", summary: "Set the priority, 1 highest" },
      { flag: "--start", value: "<date>", summary: "Set the start date" },
      { flag: "--target", value: "<date>", summary: "Set the target date" },
    ],
  },
  {
    path: ["project", "list"],
    summary: "List active projects (or all with --all), ordered by key",
    synopsis: "project list [--all]",
    description:
      "Lists projects ordered by key; columns are key, name, status, priority (or `-`), done/total progress, target date (or `-`), and `no`/`yes` for archived.",
    options: [{ flag: "--all", summary: "Include archived projects" }],
  },
  {
    path: ["project", "show"],
    summary: "Show project properties and progress",
    synopsis: "project show <KEY>",
    description:
      "Prints the project with its summary, description, dates, progress, and archive state.",
    arguments: [{ name: "KEY", required: true, summary: "Project key" }],
  },
  {
    path: ["project", "edit"],
    summary: "Edit a project",
    synopsis:
      "project edit <KEY> [--name <name>] [--summary <text>] [--description <text>] [--status <status>] [--priority <1-4|none>] [--start <date|none>] [--target <date|none>]",
    description:
      "Updates the given fields; `none` clears the priority or a date.",
    arguments: [{ name: "KEY", required: true, summary: "Project key" }],
    options: [
      { flag: "--name", value: "<name>", summary: "Set the name" },
      { flag: "--summary", value: "<text>", summary: "Set the summary" },
      { flag: "--description", value: "<text>", summary: "Set the description" },
      { flag: "--status", value: "<status>", summary: "Set the status" },
      {
        flag: "--priority",
        value: "<1-4|none>",
        summary: "Set the priority, or `none` to clear it",
      },
      {
        flag: "--start",
        value: "<date|none>",
        summary: "Set the start date, or `none` to clear it",
      },
      {
        flag: "--target",
        value: "<date|none>",
        summary: "Set the target date, or `none` to clear it",
      },
    ],
  },
  {
    path: ["project", "archive"],
    summary: "Archive a project",
    synopsis: "project archive <KEY>",
    description:
      "Archives a project; it stays readable and its issues stay writable. There is no delete.",
    arguments: [{ name: "KEY", required: true, summary: "Project key" }],
  },
  {
    path: ["project", "restore"],
    summary: "Restore an archived project",
    synopsis: "project restore <KEY>",
    arguments: [{ name: "KEY", required: true, summary: "Project key" }],
  },
  {
    path: ["issue"],
    summary: "Create, list, show, and move issues",
    synopsis: "issue <subcommand>",
    description:
      "Manage issues and their event timeline. Every status change is an append-only event.",
  },
  {
    path: ["issue", "add"],
    summary: "Create an issue",
    synopsis:
      "issue add <PROJECT> <title...> [--description <text>] [--priority <1-4>] [--status <status>] [--parent <KEY>]",
    description: "Creates an issue; keys are assigned atomically per project.",
    arguments: [
      { name: "PROJECT", required: true, summary: "Project key" },
      {
        name: "title...",
        required: true,
        summary: "Issue title; the remaining words are joined with spaces",
      },
    ],
    options: [
      { flag: "--description", value: "<text>", summary: "Set the description" },
      { flag: "--priority", value: "<1-4>", summary: "Set the priority, 1 highest" },
      { flag: "--status", value: "<status>", summary: "Set the initial status" },
      { flag: "--parent", value: "<KEY>", summary: "Set the parent issue key" },
    ],
  },
  {
    path: ["issue", "list"],
    summary: "List issues ordered by project and number",
    synopsis: "issue list [PROJECT]",
    description:
      "Lists issues, optionally scoped to one project; the fifth column is the blocked reason or `-`.",
    arguments: [{ name: "PROJECT", required: false, summary: "Project key to scope the list" }],
  },
  {
    path: ["issue", "comment"],
    summary: "Append a comment event to an issue",
    synopsis:
      "issue comment <KEY> ( <body...> | --body-file <path> ) [--as-agent | --actor <agent|human|git|system> [--agent <name>]]",
    description:
      "Appends a comment event to the issue's timeline. `--body-file` reads the body from a file, for multi-line bodies and plans that do not fit safely in argv; the body is trimmed and must not be empty. `--as-agent` attributes the comment to the agent behind `CURVED_AGENT_TOKEN` and cannot be combined with `--actor`/`--agent`.",
    arguments: [
      { name: "KEY", required: true, summary: "Issue key" },
      {
        name: "body...",
        required: false,
        summary:
          "Comment body; the remaining words are joined with spaces, or pass --body-file",
      },
    ],
    options: [
      {
        flag: "--body-file",
        value: "<path>",
        summary: "Read the body from a file instead of argv",
      },
      {
        flag: "--as-agent",
        summary:
          "Attribute the comment to the agent behind CURVED_AGENT_TOKEN; excludes --actor and --agent",
      },
      {
        flag: "--actor",
        value: "<agent|human|git|system>",
        summary: "Actor recorded on the event",
      },
      { flag: "--agent", value: "<name>", summary: "Agent name for an agent actor" },
    ],
  },
  {
    path: ["issue", "block"],
    summary: "Block a claimed issue with a reason",
    synopsis: "issue block <KEY> <reason...>",
    description:
      "Blocks a claimed issue with a reason, returns it to `todo`, clears the claim, and appends a `blocked` event. Requires `CURVED_AGENT_TOKEN`.",
    arguments: [
      { name: "KEY", required: true, summary: "Issue key" },
      {
        name: "reason...",
        required: true,
        summary: "Blocked reason; the remaining words are joined with spaces",
      },
    ],
  },
  {
    path: ["issue", "unblock"],
    summary: "Clear a blocked issue's reason",
    synopsis:
      "issue unblock <KEY> [--actor <agent|human|git|system>] [--agent <name>]",
    description:
      "Clears a blocked issue's reason and appends an `unblocked` event; humans only.",
    arguments: [{ name: "KEY", required: true, summary: "Issue key" }],
    options: [
      {
        flag: "--actor",
        value: "<agent|human|git|system>",
        summary: "Actor recorded on the event",
      },
      { flag: "--agent", value: "<name>", summary: "Agent name for an agent actor" },
    ],
  },
  {
    path: ["issue", "show"],
    summary: "Show one issue with its event timeline",
    synopsis: "issue show <KEY>",
    description:
      "Prints the issue, its children, labels, blocks, blocked_by, and its timeline in ascending event order.",
    arguments: [{ name: "KEY", required: true, summary: "Issue key" }],
  },
  {
    path: ["issue", "move"],
    summary: "Move an issue to a new status",
    synopsis:
      "issue move <KEY> <status> [--body <text>] [--actor <agent|human|git|system>] [--agent <name>]",
    description: "Moves an issue along a legal edge for the given actor.",
    arguments: [
      { name: "KEY", required: true, summary: "Issue key" },
      {
        name: "status",
        required: true,
        summary: "Target status; the move must be a legal edge for the actor",
      },
    ],
    options: [
      { flag: "--body", value: "<text>", summary: "Event body recorded with the move" },
      {
        flag: "--actor",
        value: "<agent|human|git|system>",
        summary: "Actor recorded on the event",
      },
      { flag: "--agent", value: "<name>", summary: "Agent name for an agent actor" },
    ],
  },
  {
    path: ["agent"],
    summary: "Create agents",
    synopsis: "agent <subcommand>",
    description: "Manage agent identities and their tokens.",
  },
  {
    path: ["agent", "add"],
    summary: "Create an agent and print its token once",
    synopsis: "agent add <name>",
    description:
      "Creates an agent; prints its `crv_` token once, and only the SHA-256 hash is stored.",
    arguments: [{ name: "name", required: true, summary: "Agent name" }],
  },
  {
    path: ["ready"],
    summary: "List ready issues, plus the agent's busy issue",
    synopsis: "ready [PROJECT] [--human]",
    description:
      "Lists unblocked `todo` issues by priority then number, with the caller's busy issue. Requires `CURVED_AGENT_TOKEN` unless `--human` is passed.",
    arguments: [{ name: "PROJECT", required: false, summary: "Project key to scope the list" }],
    options: [
      { flag: "--human", summary: "List as the human actor instead of the agent" },
    ],
  },
  {
    path: ["claim"],
    summary: "Claim the next ready issue for the agent",
    synopsis: "claim [PROJECT]",
    description:
      "Claims the next ready issue with `for update skip locked`. Requires `CURVED_AGENT_TOKEN`.",
    arguments: [{ name: "PROJECT", required: false, summary: "Project key to scope the claim" }],
  },
  {
    path: ["review"],
    summary: "Submit a claimed issue for review",
    synopsis: "review <KEY> <summary...>",
    description: "Submits a claimed issue for review. Requires `CURVED_AGENT_TOKEN`.",
    arguments: [
      { name: "KEY", required: true, summary: "Issue key" },
      {
        name: "summary...",
        required: true,
        summary: "Review summary; the remaining words are joined with spaces",
      },
    ],
  },
  {
    path: ["release"],
    summary: "Return a claimed issue to the ready backlog",
    synopsis: "release <KEY>",
    description: "Releases the claim. Requires `CURVED_AGENT_TOKEN`.",
    arguments: [{ name: "KEY", required: true, summary: "Issue key" }],
  },
  {
    path: ["git-branch"],
    summary: "Print the git branch name for an issue",
    synopsis: "git-branch <KEY>",
    description:
      "Prints the canonical issue key plus a slug of its title as the git branch name.",
    arguments: [{ name: "KEY", required: true, summary: "Issue key" }],
  },
  {
    path: ["help"],
    summary: "Show help for a command",
    synopsis: "help [<command>...]",
    description:
      "Prints the top-level usage, or the help for one command path such as `help issue move`.",
    arguments: [
      {
        name: "command...",
        required: false,
        summary: "Command path to describe",
      },
    ],
    options: [],
  },
];

const COMMAND_INDEX = new Map(
  COMMANDS.map((command) => [command.path.join(" "), command]),
);

/** Returns the command registered at `path`, or undefined. */
export function findCommand(path: readonly string[]): CommandHelp | undefined {
  return COMMAND_INDEX.get(path.join(" "));
}

/** The direct subcommands of `path`, in catalog order. */
export function subcommandsOf(path: readonly string[]): readonly CommandHelp[] {
  return COMMANDS.filter(
    (command) =>
      command.path.length === path.length + 1 &&
      path.every((word, index) => command.path[index] === word),
  );
}

/** True when `path` names a command that has subcommands. */
export function hasSubcommands(path: readonly string[]): boolean {
  return subcommandsOf(path).length > 0;
}

function renderOptionFlag(option: CommandOption): string {
  return option.value === undefined
    ? option.flag
    : `${option.flag} ${option.value}`;
}

function renderArgumentName(argument: CommandArgument): string {
  return argument.required ? `<${argument.name}>` : `[${argument.name}]`;
}

/** A two-column list row, wrapping the summary onto its own line when long. */
function listRow(synopsis: string, summary: string): string[] {
  if (synopsis.length <= SUMMARY_COLUMN - 2) {
    return [`  ${synopsis.padEnd(SUMMARY_COLUMN - 2)}${summary}`];
  }
  return [`  ${synopsis}`, `${" ".repeat(SUMMARY_COLUMN)}${summary}`];
}

/** The top-level usage block, printed by bare `curved help` and usage errors. */
export function renderUsage(): string {
  const lines = ["Usage: curved <command> [options]", "", "Commands:"];
  for (const command of COMMANDS) {
    if (command.path.length === 0 || hasSubcommands(command.path)) {
      continue;
    }
    lines.push(...listRow(command.synopsis, command.summary));
  }
  lines.push(
    "",
    "Agent commands (ready, claim, review, release, issue block) read the agent",
    "token from CURVED_AGENT_TOKEN.",
    "",
    "Options:",
  );
  for (const option of GLOBAL_OPTIONS) {
    lines.push(...listRow(renderOptionFlag(option), option.summary));
  }
  lines.push("", `Documentation: ${DOCS_PATH}`, "");
  return lines.join("\n");
}

/** Help for one command: synopsis, arguments, flags, subcommands, and docs. */
export function renderCommandHelp(command: CommandHelp): string {
  const lines = [`Usage: curved ${command.synopsis}`];
  if (command.description !== undefined) {
    lines.push("", command.description);
  }

  const args = command.arguments ?? [];
  if (args.length > 0) {
    const width = Math.max(...args.map((arg) => renderArgumentName(arg).length));
    lines.push("", "Arguments:");
    for (const arg of args) {
      const label = renderArgumentName(arg).padEnd(width);
      lines.push(
        `  ${label}  ${arg.required ? "required" : "optional"}  ${arg.summary}`,
      );
    }
  }

  const options = [...(command.options ?? []), ...GLOBAL_OPTIONS];
  const optionWidth = Math.max(
    ...options.map((option) => renderOptionFlag(option).length),
  );
  lines.push("", "Options:");
  for (const option of options) {
    lines.push(
      `  ${renderOptionFlag(option).padEnd(optionWidth)}  ${option.summary}`,
    );
  }

  const children = subcommandsOf(command.path);
  if (children.length > 0) {
    lines.push("", "Subcommands:");
    for (const child of children) {
      lines.push(...listRow(child.synopsis, child.summary));
    }
  }

  lines.push("", `Documentation: ${DOCS_PATH}`, "");
  return lines.join("\n");
}
