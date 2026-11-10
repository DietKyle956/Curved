import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

let testDb: TestDatabase;

before(async () => {
  testDb = await openTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
});

after(async () => {
  await testDb.close();
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[]): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const child = spawn(process.execPath, ["src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: testDb.databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const out = child.stdout;
  const err = child.stderr;
  if (out === null || err === null) {
    reject(new Error("spawned CLI without piped stdio"));
    return promise;
  }
  out.setEncoding("utf8");
  err.setEncoding("utf8");
  out.on("data", (chunk: string) => {
    stdout += chunk;
  });
  err.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

test("project add --json exits 0 and prints the created project", async () => {
  const result = await runCli(["project", "add", "TAC", "Tac", "--json"]);

  assert.equal(result.code, 0, result.stderr);
  const project = JSON.parse(result.stdout) as {
    key: string;
    name: string;
    nextNumber: number;
    createdAt: string;
  };
  assert.equal(project.key, "TAC");
  assert.equal(project.name, "Tac");
  assert.equal(project.nextNumber, 1);
  assert.equal(new Date(project.createdAt).toISOString(), project.createdAt);
});

test("project list --json returns the created project", async () => {
  const added = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(added.code, 0, added.stderr);

  const result = await runCli(["project", "list", "--json"]);

  assert.equal(result.code, 0, result.stderr);
  const projects = JSON.parse(result.stdout) as Array<{
    key: string;
    name: string;
  }>;
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.key, "TAC");
  assert.equal(projects[0]?.name, "Tac");
});

test("a duplicate project add exits 1 with a duplicate error on stderr", async () => {
  const first = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(first.code, 0, first.stderr);

  const result = await runCli(["project", "add", "TAC", "Tac", "--json"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^duplicate: /);
  assert.equal(result.stdout, "");
});

test("issue add --json prints the created issue", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);

  const result = await runCli([
    "issue",
    "add",
    "TAC",
    "Fix",
    "the",
    "flux",
    "capacitor",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr);
  const issue = JSON.parse(result.stdout) as {
    key: string;
    projectKey: string;
    number: number;
    title: string;
    status: string;
    priority: number;
    description: string;
    parentId: number | null;
    blockedReason: string | null;
    claimedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  assert.equal(issue.key, "TAC-1");
  assert.equal(issue.projectKey, "TAC");
  assert.equal(issue.number, 1);
  assert.equal(issue.title, "Fix the flux capacitor");
  assert.equal(issue.status, "backlog");
  assert.equal(issue.priority, 3);
  assert.equal(issue.description, "");
  assert.equal(issue.parentId, null);
});

test("issue add honors --description, --priority, and --status", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);

  const result = await runCli([
    "issue",
    "add",
    "TAC",
    "Ship",
    "it",
    "--description",
    "Detailed notes",
    "--priority",
    "1",
    "--status",
    "todo",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr);
  const issue = JSON.parse(result.stdout) as {
    key: string;
    title: string;
    description: string;
    priority: number;
    status: string;
  };
  assert.equal(issue.key, "TAC-1");
  assert.equal(issue.title, "Ship it");
  assert.equal(issue.description, "Detailed notes");
  assert.equal(issue.priority, 1);
  assert.equal(issue.status, "todo");
});

test("issue list --json returns created issues, with and without a project filter", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "First", "issue", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const all = await runCli(["issue", "list", "--json"]);
  assert.equal(all.code, 0, all.stderr);
  const allIssues = JSON.parse(all.stdout) as Array<{ key: string }>;
  assert.equal(allIssues.length, 1);
  assert.equal(allIssues[0]?.key, "TAC-1");

  const filtered = await runCli(["issue", "list", "TAC", "--json"]);
  assert.equal(filtered.code, 0, filtered.stderr);
  const filteredIssues = JSON.parse(filtered.stdout) as Array<{ key: string }>;
  assert.equal(filteredIssues.length, 1);
  assert.equal(filteredIssues[0]?.key, "TAC-1");
});

test("issue show resolves padded keys to the canonical form", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "First", "issue", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const result = await runCli(["issue", "show", "TAC-001", "--json"]);

  assert.equal(result.code, 0, result.stderr);
  const issue = JSON.parse(result.stdout) as { key: string; number: number };
  assert.equal(issue.key, "TAC-1");
  assert.equal(issue.number, 1);
});

test("issue show of an unknown key exits 1 with a not_found error", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);

  const result = await runCli(["issue", "show", "TAC-99", "--json"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^not_found: /);
  assert.equal(result.stdout, "");
});

test("issue add into a missing project exits 1 with a not_found error", async () => {
  const result = await runCli(["issue", "add", "NOPE", "Orphan", "issue", "--json"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^not_found: /);
  assert.equal(result.stdout, "");
});

test("issue add without a title exits 2 with the usage block", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);

  const result = await runCli(["issue", "add", "TAC"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage: curved <command> \[options\]/);
  assert.equal(result.stdout, "");
});

test("issue add, list, and show print the pinned human formats", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);

  const added = await runCli([
    "issue",
    "add",
    "TAC",
    "Fix the flux capacitor",
    "--description",
    "Needs 1.21 GW",
  ]);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.stdout, "created issue TAC-1 (Fix the flux capacitor)\n");

  const listed = await runCli(["issue", "list", "TAC"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stdout, "TAC-1\tbacklog\t3\tFix the flux capacitor\n");

  const json = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const issue = JSON.parse(json.stdout) as { createdAt: string; updatedAt: string };

  const shown = await runCli(["issue", "show", "TAC-1"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(
    shown.stdout,
    [
      "key: TAC-1",
      "status: backlog",
      "priority: 3",
      "title: Fix the flux capacitor",
      "description: Needs 1.21 GW",
      "parent: -",
      "blocked_reason: -",
      "claimed_by: -",
      `created_at: ${issue.createdAt}`,
      `updated_at: ${issue.updatedAt}`,
      "",
    ].join("\n"),
  );
});
