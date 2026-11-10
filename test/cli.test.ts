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
