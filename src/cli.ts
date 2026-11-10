import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
import { createDatabase } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { runMigrations } from "./migrate.ts";
import { authenticateAgent, createAgent } from "./services/agents.ts";
import { blockIssue, unblockIssue } from "./services/blocking.ts";
import { commentOnIssue } from "./services/comments.ts";
import {
  createIssue,
  getIssueTimeline,
  listIssues,
  moveIssue,
} from "./services/issues.ts";
import { createProject, listProjects } from "./services/projects.ts";
import {
  claimNext,
  listReady,
  releaseClaim,
  submitForReview,
} from "./services/queue.ts";

const USAGE = `Usage: curved <command> [options]

Commands:
  migrate                     Apply pending database migrations
  project add <KEY> <name>    Create a project
  project list                List projects ordered by key
  issue add <PROJECT> <title...> [--description <text>] [--priority <1-4>] [--status <status>] [--parent <KEY>]
                              Create an issue
  issue list [PROJECT]        List issues ordered by project and number
  issue comment <KEY> <body...> [--actor <agent|human|git|system>] [--agent <name>]
                              Append a comment event to an issue
  issue block <KEY> <reason...>
                              Block a claimed issue with a reason
  issue unblock <KEY> [--actor <agent|human|git|system>] [--agent <name>]
                              Clear a blocked issue's reason
  issue show <KEY>            Show one issue with its event timeline
  issue move <KEY> <status> [--body <text>] [--actor <agent|human|git|system>] [--agent <name>]
                              Move an issue to a new status
  agent add <name>            Create an agent and print its token once
  ready [PROJECT] [--human]   List ready issues, plus the agent's busy issue
  claim [PROJECT]             Claim the next ready issue for the agent
  review <KEY> <summary...>   Submit a claimed issue for review
  release <KEY>               Return a claimed issue to the ready backlog
  help                        Show this help

Agent commands (ready, claim, review, release, issue block) read the agent
token from CURVED_AGENT_TOKEN.

Options:
  --json    Print machine-readable JSON on stdout
`;

class UsageError extends Error {}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function withDatabase<T>(
  fn: (db: Database, config: Config) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  try {
    return await fn(db, config);
  } finally {
    await db.close();
  }
}

function requireAgentToken(config: Config): string {
  const token = config.agentToken.trim();
  if (token.length === 0) {
    throw new ServiceError(
      "not_authenticated",
      'no agent token: create an agent with "curved agent add <name>" and set CURVED_AGENT_TOKEN to its token',
    );
  }
  return token;
}

async function withAgent<T>(
  db: Database,
  config: Config,
  fn: (agentName: string) => Promise<T>,
): Promise<T> {
  const agent = await authenticateAgent(db, requireAgentToken(config));
  return fn(agent.name);
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
  agent: string | undefined;
} {
  const positionals: string[] = [];
  let actor: string | undefined;
  let agent: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--actor" || arg === "--agent") {
      const value = rest[index + 1];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--actor") {
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

  return { positionals, actor, agent };
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

function parseIssueBlockArgs(rest: readonly string[]): {
  positionals: string[];
} {
  const positionals: string[] = [];

  for (const arg of rest) {
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }

  return { positionals };
}

function parseIssueUnblockArgs(rest: readonly string[]): {
  positionals: string[];
  actor: string | undefined;
  agent: string | undefined;
} {
  const positionals: string[] = [];
  let actor: string | undefined;
  let agent: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--actor" || arg === "--agent") {
      const value = rest[index + 1];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--actor") {
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

  return { positionals, actor, agent };
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
          .map(
            (issue) =>
              `${issue.key}\t${issue.status}\t${issue.priority}\t${issue.title}\t${issue.blockedReason ?? "-"}\n`,
          )
          .join(""),
      );
    }
    return;
  }

  if (subcommand === "comment") {
    const { positionals, actor, agent } = parseIssueCommentArgs(rest);
    const [key, ...words] = positionals;
    if (key === undefined) {
      throw new UsageError("issue comment requires <KEY> <body...>");
    }
    if (words.length === 0) {
      throw new UsageError("issue comment requires a body");
    }
    const body = words.join(" ");
    const event = await withDatabase((db) =>
      commentOnIssue(db, { key, body, actor, agent }),
    );
    if (json) {
      printJson(event);
    } else {
      process.stdout.write(`commented on ${key} as ${event.actorType}\n`);
    }
    return;
  }

  if (subcommand === "block") {
    const { positionals } = parseIssueBlockArgs(rest);
    const [key, ...words] = positionals;
    if (key === undefined) {
      throw new UsageError("issue block requires <KEY> <reason...>");
    }
    if (words.length === 0) {
      throw new UsageError("issue block requires a reason");
    }
    const reason = words.join(" ");
    const issue = await withDatabase((db, config) =>
      withAgent(db, config, (agent) =>
        blockIssue(db, { key, agent, reason }),
      ),
    );
    if (json) {
      printJson(issue);
    } else {
      process.stdout.write(`blocked ${issue.key}\n`);
    }
    return;
  }

  if (subcommand === "unblock") {
    const { positionals, actor, agent } = parseIssueUnblockArgs(rest);
    const [key, ...extra] = positionals;
    if (key === undefined) {
      throw new UsageError("issue unblock requires <KEY>");
    }
    if (extra.length > 0) {
      throw new UsageError("issue unblock accepts exactly one KEY argument");
    }
    const issue = await withDatabase((db) =>
      unblockIssue(db, { key, actor, agent }),
    );
    if (json) {
      printJson(issue);
    } else {
      process.stdout.write(`unblocked ${issue.key}\n`);
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
      ? "issue requires a subcommand (add, list, comment, block, unblock, show, move)"
      : `unknown issue subcommand "${subcommand}"`,
  );
}

async function runAgentCommand(
  subcommand: string | undefined,
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  if (subcommand === "add") {
    const positionals: string[] = [];
    for (const arg of rest) {
      if (arg.startsWith("--")) {
        throw new UsageError(`unknown option "${arg}"`);
      }
      positionals.push(arg);
    }
    const [name, ...extra] = positionals;
    if (name === undefined) {
      throw new UsageError("agent add requires <name>");
    }
    if (extra.length > 0) {
      throw new UsageError("agent add requires exactly one name");
    }
    const created = await withDatabase((db) => createAgent(db, name));
    if (json) {
      printJson({ ...created.agent, token: created.token });
    } else {
      process.stdout.write(
        `created agent ${created.agent.name}\ntoken: ${created.token}\n`,
      );
    }
    return;
  }

  throw new UsageError(
    subcommand === undefined
      ? "agent requires a subcommand (add)"
      : `unknown agent subcommand "${subcommand}"`,
  );
}

async function runReadyCommand(
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  const positionals: string[] = [];
  let human = false;

  for (const arg of rest) {
    if (arg === "--human") {
      human = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }

  const [project, ...extra] = positionals;
  if (extra.length > 0) {
    throw new UsageError("ready accepts at most one PROJECT argument");
  }
  const options = project === undefined ? undefined : { project };
  const queue = await withDatabase(async (db, config) => {
    if (human) {
      return listReady(db, options, { actor: "human" });
    }
    return withAgent(db, config, (agent) =>
      listReady(db, options, { actor: "agent", agent }),
    );
  });
  if (json) {
    printJson(queue);
  } else {
    const lines = queue.ready.map(
      (issue) => `${issue.key}\t${issue.priority}\t${issue.status}\t${issue.title}\n`,
    );
    lines.push(`busy: ${queue.busy === null ? "-" : queue.busy}\n`);
    process.stdout.write(lines.join(""));
  }
}

async function runClaimCommand(
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  const positionals: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }
  const [project, ...extra] = positionals;
  if (extra.length > 0) {
    throw new UsageError("claim accepts at most one PROJECT argument");
  }
  const options = project === undefined ? {} : { project };
  const issue = await withDatabase((db, config) =>
    withAgent(db, config, (agent) => claimNext(db, options, agent)),
  );
  if (json) {
    printJson(issue);
  } else {
    process.stdout.write(`claimed ${issue.key}\n`);
  }
}

async function runReviewCommand(
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  const positionals: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }
  const [key, ...words] = positionals;
  if (key === undefined || words.length === 0) {
    throw new UsageError("review requires <KEY> <summary...>");
  }
  const summary = words.join(" ");
  const issue = await withDatabase((db, config) =>
    withAgent(db, config, (agent) =>
      submitForReview(db, { key, agent, summary }),
    ),
  );
  if (json) {
    printJson(issue);
  } else {
    process.stdout.write(`submitted ${issue.key} for review\n`);
  }
}

async function runReleaseCommand(
  rest: readonly string[],
  json: boolean,
): Promise<void> {
  const positionals: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      throw new UsageError(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }
  const [key, ...extra] = positionals;
  if (key === undefined) {
    throw new UsageError("release requires <KEY>");
  }
  if (extra.length > 0) {
    throw new UsageError("release accepts exactly one KEY argument");
  }
  const issue = await withDatabase((db, config) =>
    withAgent(db, config, (agent) => releaseClaim(db, { key, agent })),
  );
  if (json) {
    printJson(issue);
  } else {
    process.stdout.write(`released ${issue.key}\n`);
  }
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

  if (command === "agent") {
    await runAgentCommand(subcommand, rest, json);
    return;
  }

  if (command === "ready") {
    await runReadyCommand(args.slice(1), json);
    return;
  }

  if (command === "claim") {
    await runClaimCommand(args.slice(1), json);
    return;
  }

  if (command === "review") {
    await runReviewCommand(args.slice(1), json);
    return;
  }

  if (command === "release") {
    await runReleaseCommand(args.slice(1), json);
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
