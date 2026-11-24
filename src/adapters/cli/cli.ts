import { ServiceError } from "../../domain/errors.ts";
import { branchNameForIssue } from "../../domain/keys.ts";
import type { ProjectWithProgress } from "../../domain/types.ts";
import { authenticateAgent, createAgent } from "../../application/agents.ts";
import { blockIssue, unblockIssue } from "../../application/blocking.ts";
import { commentOnIssue } from "../../application/comments.ts";
import {
  createIssue,
  getIssue,
  getIssueTimeline,
  listIssues,
  moveIssue,
} from "../../application/issues.ts";
import type { Ports } from "../../application/ports.ts";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
} from "../../application/projects.ts";
import {
  claimNext,
  listReady,
  releaseClaim,
  submitForReview,
} from "../../application/queue.ts";

const USAGE = `Usage: curved <command> [options]

Commands:
  migrate                     Apply pending database migrations
  project add <KEY> <name...> [--summary <text>] [--description <text>] [--status <status>] [--priority <1-4>] [--start <date>] [--target <date>]
                              Create a project
  project list [--all]        List active projects (or all with --all), ordered by key
  project show <KEY>          Show project properties and progress
  project edit <KEY> [--name <name>] [--summary <text>] [--description <text>] [--status <status>] [--priority <1-4|none>] [--start <date|none>] [--target <date|none>]
                              Edit a project
  project archive <KEY>       Archive a project
  project restore <KEY>       Restore an archived project
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
  git-branch <KEY>            Print the git branch name for an issue
  help                        Show this help

Agent commands (ready, claim, review, release, issue block) read the agent
token from CURVED_AGENT_TOKEN.

Options:
  --json    Print machine-readable JSON on stdout
`;

/** The process-level dependencies a CLI invocation needs. */
export interface CliDeps {
  agentToken: string;
  withPorts<T>(fn: (ports: Ports) => Promise<T>): Promise<T>;
  migrate(): Promise<string[]>;
}

class UsageError extends Error {}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireAgentToken(agentToken: string): string {
  const token = agentToken.trim();
  if (token.length === 0) {
    throw new ServiceError(
      "not_authenticated",
      'no agent token: create an agent with "curved agent add <name>" and set CURVED_AGENT_TOKEN to its token',
    );
  }
  return token;
}

async function withAgent<T>(
  ports: Ports,
  deps: CliDeps,
  fn: (agentName: string) => Promise<T>,
): Promise<T> {
  const agent = await authenticateAgent(ports, requireAgentToken(deps.agentToken));
  return fn(agent.name);
}

interface ProjectFlags {
  name: string | undefined;
  summary: string | undefined;
  description: string | undefined;
  status: string | undefined;
  priority: string | undefined;
  start: string | undefined;
  target: string | undefined;
  all: boolean;
}

function parseProjectArgs(rest: readonly string[]): {
  positionals: string[];
  flags: ProjectFlags;
} {
  const positionals: string[] = [];
  const flags: ProjectFlags = {
    name: undefined,
    summary: undefined,
    description: undefined,
    status: undefined,
    priority: undefined,
    start: undefined,
    target: undefined,
    all: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--all") {
      flags.all = true;
      continue;
    }
    if (
      arg === "--name" ||
      arg === "--summary" ||
      arg === "--description" ||
      arg === "--status" ||
      arg === "--priority" ||
      arg === "--start" ||
      arg === "--target"
    ) {
      const value = rest[index + 1];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--name") {
        flags.name = value;
      } else if (arg === "--summary") {
        flags.summary = value;
      } else if (arg === "--description") {
        flags.description = value;
      } else if (arg === "--status") {
        flags.status = value;
      } else if (arg === "--priority") {
        flags.priority = value;
      } else if (arg === "--start") {
        flags.start = value;
      } else {
        flags.target = value;
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

function hasProjectFlags(flags: ProjectFlags): boolean {
  return (
    flags.name !== undefined ||
    flags.summary !== undefined ||
    flags.description !== undefined ||
    flags.status !== undefined ||
    flags.priority !== undefined ||
    flags.start !== undefined ||
    flags.target !== undefined ||
    flags.all
  );
}

function formatProjectRow(project: ProjectWithProgress): string {
  const priority = project.priority === null ? "-" : String(project.priority);
  const target = project.targetDate === null ? "-" : project.targetDate;
  const archived = project.archivedAt === null ? "no" : "yes";
  return `${project.key}\t${project.name}\t${project.status}\t${priority}\t${project.progress.done}/${project.progress.total}\t${target}\t${archived}\n`;
}

function formatProjectShow(project: ProjectWithProgress): string {
  const priority = project.priority === null ? "-" : String(project.priority);
  const start = project.startDate === null ? "-" : project.startDate;
  const target = project.targetDate === null ? "-" : project.targetDate;
  const archived = project.archivedAt === null ? "no" : "yes";
  return [
    `${project.key}\t${project.name}`,
    `status\t${project.status}`,
    `priority\t${priority}`,
    `start\t${start}`,
    `target\t${target}`,
    `progress\t${project.progress.done}/${project.progress.total}`,
    `archived\t${archived}`,
    `summary\t${project.summary}`,
    `description\t${project.description}`,
    "",
  ].join("\n");
}

async function runProjectCommand(
  subcommand: string | undefined,
  rest: readonly string[],
  json: boolean,
  deps: CliDeps,
): Promise<void> {
  if (subcommand === "add") {
    const { positionals, flags } = parseProjectArgs(rest);
    if (flags.all) {
      throw new UsageError("--all is only accepted by project list");
    }
    if (flags.name !== undefined) {
      throw new UsageError(
        "project add takes the name as positional arguments, not --name",
      );
    }
    const [key, ...words] = positionals;
    if (key === undefined || words.length === 0) {
      throw new UsageError("project add requires <KEY> <name...>");
    }
    const name = words.join(" ");
    const project = await deps.withPorts((ports) =>
      createProject(ports, {
        key,
        name,
        summary: flags.summary,
        description: flags.description,
        status: flags.status,
        priority:
          flags.priority === undefined ? undefined : Number(flags.priority),
        startDate: flags.start,
        targetDate: flags.target,
      }),
    );
    if (json) {
      printJson(project);
    } else {
      process.stdout.write(`created project ${project.key} (${project.name})\n`);
    }
    return;
  }

  if (subcommand === "list") {
    const { positionals, flags } = parseProjectArgs(rest);
    if (positionals.length > 0) {
      throw new UsageError("project list accepts no positional arguments");
    }
    const projects = await deps.withPorts((ports) =>
      listProjects(ports, { includeArchived: flags.all }),
    );
    if (json) {
      printJson(projects);
    } else {
      process.stdout.write(projects.map(formatProjectRow).join(""));
    }
    return;
  }

  if (
    subcommand === "show" ||
    subcommand === "archive" ||
    subcommand === "restore"
  ) {
    const { positionals, flags } = parseProjectArgs(rest);
    if (hasProjectFlags(flags)) {
      throw new UsageError(`project ${subcommand} accepts no options`);
    }
    const [key, ...extra] = positionals;
    if (key === undefined) {
      throw new UsageError(`project ${subcommand} requires <KEY>`);
    }
    if (extra.length > 0) {
      throw new UsageError(
        `project ${subcommand} accepts exactly one KEY argument`,
      );
    }
    const project = await deps.withPorts((ports) =>
      subcommand === "show"
        ? getProject(ports, key)
        : updateProject(ports, {
            key,
            archived: subcommand === "archive",
          }),
    );
    if (json) {
      printJson(project);
    } else if (subcommand === "show") {
      process.stdout.write(formatProjectShow(project));
    } else {
      const verb = subcommand === "archive" ? "archived" : "restored";
      process.stdout.write(`${verb} project ${project.key}\n`);
    }
    return;
  }

  if (subcommand === "edit") {
    const { positionals, flags } = parseProjectArgs(rest);
    if (flags.all) {
      throw new UsageError("--all is only accepted by project list");
    }
    const [key, ...extra] = positionals;
    if (key === undefined) {
      throw new UsageError("project edit requires <KEY>");
    }
    if (extra.length > 0) {
      throw new UsageError(
        "project edit accepts exactly one KEY argument",
      );
    }
    const project = await deps.withPorts((ports) =>
      updateProject(ports, {
        key,
        name: flags.name,
        summary: flags.summary,
        description: flags.description,
        status: flags.status,
        priority:
          flags.priority === undefined
            ? undefined
            : flags.priority === "none"
              ? null
              : Number(flags.priority),
        startDate:
          flags.start === undefined
            ? undefined
            : flags.start === "none"
              ? null
              : flags.start,
        targetDate:
          flags.target === undefined
            ? undefined
            : flags.target === "none"
              ? null
              : flags.target,
      }),
    );
    if (json) {
      printJson(project);
    } else {
      process.stdout.write(`updated project ${project.key}\n`);
    }
    return;
  }

  const supported = "add, list, show, edit, archive, restore";
  throw new UsageError(
    subcommand === undefined
      ? `project requires a subcommand (${supported})`
      : `unknown project subcommand "${subcommand}" (supported: ${supported})`,
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
  deps: CliDeps,
): Promise<void> {
  if (subcommand === "add") {
    const { positionals, flags } = parseIssueAddArgs(rest);
    const [project, ...words] = positionals;
    if (project === undefined || words.length === 0) {
      throw new UsageError("issue add requires <PROJECT> <title...>");
    }
    const title = words.join(" ");
    const issue = await deps.withPorts((ports) =>
      createIssue(ports, {
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
    const issues = await deps.withPorts((ports) => listIssues(ports, filter));
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
    const event = await deps.withPorts((ports) =>
      commentOnIssue(ports, { key, body, actor, agent }),
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
    const issue = await deps.withPorts((ports) =>
      withAgent(ports, deps, (agent) => blockIssue(ports, { key, agent, reason })),
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
    const issue = await deps.withPorts((ports) =>
      unblockIssue(ports, { key, actor, agent }),
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
    const { issue, events, children } = await deps.withPorts((ports) =>
      getIssueTimeline(ports, key),
    );
    if (json) {
      printJson({ ...issue, events, children });
    } else {
      const lines = [
        `key: ${issue.key}`,
        `status: ${issue.status}`,
        `priority: ${issue.priority}`,
        `title: ${issue.title}`,
        `description: ${issue.description}`,
        `parent: ${issue.parentKey === null ? "-" : issue.parentKey}`,
        `children: ${children.length}`,
        ...children.map((child) => `  ${child.key}\t${child.status}\t${child.title}`),
        `labels: ${issue.labels.length === 0 ? "-" : issue.labels.join(", ")}`,
        `blocks: ${issue.relations.blocks.length === 0 ? "-" : issue.relations.blocks.join(", ")}`,
        `blocked_by: ${issue.relations.blockedBy.length === 0 ? "-" : issue.relations.blockedBy.join(", ")}`,
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
    const issue = await deps.withPorts((ports) =>
      moveIssue(ports, { key, to: status, actor, agent, body }),
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
  deps: CliDeps,
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
    const created = await deps.withPorts((ports) => createAgent(ports, name));
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
  deps: CliDeps,
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
  const queue = await deps.withPorts(async (ports) => {
    if (human) {
      return listReady(ports, options, { actor: "human" });
    }
    return withAgent(ports, deps, (agent) =>
      listReady(ports, options, { actor: "agent", agent }),
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
  deps: CliDeps,
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
  const issue = await deps.withPorts((ports) =>
    withAgent(ports, deps, (agent) => claimNext(ports, options, agent)),
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
  deps: CliDeps,
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
  const issue = await deps.withPorts((ports) =>
    withAgent(ports, deps, (agent) =>
      submitForReview(ports, { key, agent, summary }),
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
  deps: CliDeps,
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
  const issue = await deps.withPorts((ports) =>
    withAgent(ports, deps, (agent) => releaseClaim(ports, { key, agent })),
  );
  if (json) {
    printJson(issue);
  } else {
    process.stdout.write(`released ${issue.key}\n`);
  }
}

async function runGitBranchCommand(
  rest: readonly string[],
  json: boolean,
  deps: CliDeps,
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
    throw new UsageError("git-branch requires <KEY>");
  }
  if (extra.length > 0) {
    throw new UsageError("git-branch accepts exactly one KEY argument");
  }
  const issue = await deps.withPorts((ports) =>
    getIssue(ports, key, { actor: "human" }),
  );
  const branch = branchNameForIssue(issue.key, issue.title);
  if (json) {
    printJson({ key: issue.key, branch });
  } else {
    process.stdout.write(`${branch}\n`);
  }
}

async function main(argv: readonly string[], deps: CliDeps): Promise<void> {
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
    const applied = await deps.migrate();
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
    await runProjectCommand(subcommand, rest, json, deps);
    return;
  }

  if (command === "issue") {
    await runIssueCommand(subcommand, rest, json, deps);
    return;
  }

  if (command === "agent") {
    await runAgentCommand(subcommand, rest, json, deps);
    return;
  }

  if (command === "ready") {
    await runReadyCommand(args.slice(1), json, deps);
    return;
  }

  if (command === "claim") {
    await runClaimCommand(args.slice(1), json, deps);
    return;
  }

  if (command === "review") {
    await runReviewCommand(args.slice(1), json, deps);
    return;
  }

  if (command === "release") {
    await runReleaseCommand(args.slice(1), json, deps);
    return;
  }

  if (command === "git-branch") {
    await runGitBranchCommand(args.slice(1), json, deps);
    return;
  }

  throw new UsageError(`unknown command "${command}"`);
}

/** Runs one CLI invocation and returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  try {
    await main(argv, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof ServiceError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}
