import { loadConfig } from "./config.ts";
import type { Database } from "./db.ts";
import { createDatabase } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { runMigrations } from "./migrate.ts";
import { commentOnIssue } from "./services/comments.ts";
import {
  createIssue,
  getIssueTimeline,
  listIssues,
  moveIssue,
} from "./services/issues.ts";
import { createProject, listProjects } from "./services/projects.ts";

const USAGE = `Usage: curved <command> [options]

Commands:
  migrate                     Apply pending database migrations
  project add <KEY> <name>    Create a project
  project list                List projects ordered by key
  issue add <PROJECT> <title...> [--description <text>] [--priority <1-4>] [--status <status>] [--parent <KEY>]
                              Create an issue
  issue list [PROJECT]        List issues ordered by project and number
  issue comment <KEY> <body...> [--actor <agent|human|git|system>]
                              Append a comment event to an issue
  issue show <KEY>            Show one issue with its event timeline
  issue move <KEY> <status> [--body <text>] [--actor <agent|human|git|system>] [--agent <name>]
                              Move an issue to a new status
  help                        Show this help

Options:
  --json    Print machine-readable JSON on stdout
`;

class UsageError extends Error {}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function withDatabase<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = createDatabase(loadConfig().databaseUrl);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function runProjectCommand(
  subcommand: string | undefined,
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  if (subcommand === "add") {
    const [key, ...words] = rest;
    if (key === undefined || words.length === 0) {
      throw new UsageError("project add requires <KEY> <name>");
    }
    const name = words.join(" ");
    const project = await withDatabase((db) =>
      createProject(db, { key, name }),
    );
    if (json) {
      printJson(project);
    } else {
      process.stdout.write(`created project ${project.key} (${project.name})\n`);
    }
    return;
  }

  if (subcommand === "list") {
    const projects = await withDatabase((db) => listProjects(db));
    if (json) {
      printJson(projects);
    } else {
      process.stdout.write(
        projects.map((project) => `${project.key}\t${project.name}\n`).join(""),
      );
    }
    return;
  }

  throw new UsageError(
    subcommand === undefined
      ? "project requires a subcommand (add, list)"
      : `unknown project subcommand "${subcommand}"`,
  );
}

interface IssueAddFlags {
  description: string | undefined;
  priority: string | undefined;
  status: string | undefined;
  parent: string | undefined;
}

function parseIssueAddArgs(rest: readonly string[]): {
  positionals: string[];
  flags: IssueAddFlags;
} {
  const positionals: string[] = [];
  const flags: IssueAddFlags = {
    description: undefined,
    priority: undefined,
    status: undefined,
    parent: undefined,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }
    if (
      arg === "--description" ||
      arg === "--priority" ||
      arg === "--status" ||
      arg === "--parent"
    ) {
      const value = rest[index + 1];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--description") {
        flags.description = value;
      } else if (arg === "--priority") {
        flags.priority = value;
      } else if (arg === "--status") {
        flags.status = value;
      } else {
        flags.parent = value;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

function parseIssueCommentArgs(rest: readonly string[]): {
  positionals: string[];
  actor: string | undefined;
} {
  const positionals: string[] = [];
  let actor: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--actor") {
      const value = rest[index + 1];
      if (value === undefined) {
        throw new UsageError("--actor requires a value");
      }
      index += 1;
      actor = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }

  return { positionals, actor };
}

function parseIssueMoveArgs(rest: readonly string[]): {
  positionals: string[];
  body: string | undefined;
  actor: string | undefined;
  agent: string | undefined;
} {
  const positionals: string[] = [];
  let body: string | undefined;
  let actor: string | undefined;
  let agent: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--body" || arg === "--actor" || arg === "--agent") {
      const value = rest[index + 1];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--body") {
        body = value;
      } else if (arg === "--actor") {
        actor = value;
      } else {
        agent = value;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }

  return { positionals, body, actor, agent };
}

async function runIssueCommand(
  subcommand: string | undefined,
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  if (subcommand === "add") {
    const { positionals, flags } = parseIssueAddArgs(rest);
    const [project, ...words] = positionals;
    if (project === undefined || words.length === 0) {
      throw new UsageError("issue add requires <PROJECT> <title...>");
    }
    const title = words.join(" ");
    const issue = await withDatabase((db) =>
      createIssue(db, {
        project,
        title,
        description: flags.description,
        priority: flags.priority === undefined ? undefined : Number(flags.priority),
        status: flags.status,
        parent: flags.parent,
      }),
    );
    if (json) {
      printJson(issue);
    } else {
      process.stdout.write(`created issue ${issue.key} (${issue.title})\n`);
    }
    return;
  }

  if (subcommand === "list") {
    const [project, ...extra] = rest;
    if (extra.length > 0) {
      throw new UsageError("issue list accepts at most one PROJECT argument");
    }
    const filter = project === undefined ? undefined : { project };
    const issues = await withDatabase((db) => listIssues(db, filter));
    if (json) {
      printJson(issues);
    } else {
      process.stdout.write(
        issues
          .map((issue) => `${issue.key}\t${issue.status}\t${issue.priority}\t${issue.title}\n`)
          .join(""),
      );
    }
    return;
  }

  if (subcommand === "comment") {
    const { positionals, actor } = parseIssueCommentArgs(rest);
    const [key, ...words] = positionals;
    if (key === undefined) {
      throw new UsageError("issue comment requires <KEY> <body...>");
    }
    if (words.length === 0) {
      throw new UsageError("issue comment requires a body");
    }
    const body = words.join(" ");
    const event = await withDatabase((db) =>
      commentOnIssue(db, { key, body, actor }),
    );
    if (json) {
      printJson(event);
    } else {
      process.stdout.write(`commented on ${key} as ${event.actorType}\n`);
    }
    return;
  }

  if (subcommand === "show") {
    const [key, ...extra] = rest;
    if (key === undefined) {
      throw new UsageError("issue show requires <KEY>");
    }
    if (extra.length > 0) {
      throw new UsageError("issue show accepts exactly one KEY argument");
    }
    const { issue, events } = await withDatabase((db) =>
      getIssueTimeline(db, key),
    );
    if (json) {
      printJson({ ...issue, events });
    } else {
      const lines = [
        `key: ${issue.key}`,
        `status: ${issue.status}`,
        `priority: ${issue.priority}`,
        `title: ${issue.title}`,
        `description: ${issue.description}`,
        `parent: ${issue.parentId === null ? "-" : String(issue.parentId)}`,
        `blocked_reason: ${issue.blockedReason === null ? "-" : issue.blockedReason}`,
        `claimed_by: ${issue.claimedBy === null ? "-" : issue.claimedBy}`,
        `created_at: ${issue.createdAt}`,
        `updated_at: ${issue.updatedAt}`,
        "",
        "timeline:",
      ];
      for (const event of events) {
        lines.push(
          `${event.id}\t${event.kind}\t${event.actorType}\t${event.createdAt}\t${event.body === null ? "-" : event.body}`,
        );
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return;
  }

  if (subcommand === "move") {
    const { positionals, body, actor, agent } = parseIssueMoveArgs(rest);
    const [key, status, ...extra] = positionals;
    if (key === undefined || status === undefined) {
      throw new UsageError("issue move requires <KEY> <status>");
    }
    if (extra.length > 0) {
      throw new UsageError("issue move requires exactly <KEY> <status>");
    }
    const issue = await withDatabase((db) =>
      moveIssue(db, { key, to: status, actor, agent, body }),
    );
    if (json) {
      printJson(issue);
    } else {
      process.stdout.write(`moved ${issue.key} to ${issue.status}\n`);
    }
    return;
  }

  throw new UsageError(
    subcommand === undefined
      ? "issue requires a subcommand (add, list, comment, show, move)"
      : `unknown issue subcommand "${subcommand}"`,
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const [command, subcommand, ...rest] = args;

  if (command === undefined) {
    throw new UsageError("missing command");
  }

  if (command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "migrate") {
    const config = loadConfig();
    const applied = await runMigrations({ databaseUrl: config.databaseUrl });
    if (json) {
      printJson(applied);
    } else if (applied.length === 0) {
      process.stdout.write("already up to date\n");
    } else {
      process.stdout.write(`${applied.join(", ")}\n`);
    }
    return;
  }

  if (command === "project") {
    await runProjectCommand(subcommand, rest, json);
    return;
  }

  if (command === "issue") {
    await runIssueCommand(subcommand, rest, json);
    return;
  }

  throw new UsageError(`unknown command "${command}"`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof ServiceError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
