import { loadConfig } from "./config.ts";
import type { Database } from "./db.ts";
import { createDatabase } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { runMigrations } from "./migrate.ts";
import { createProject, listProjects } from "./services/projects.ts";

const USAGE = `Usage: curved <command> [options]

Commands:
  migrate                     Apply pending database migrations
  project add <KEY> <name>    Create a project
  project list                List projects ordered by key
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
