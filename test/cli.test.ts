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

interface TimelineEvent {
  id: number;
  issueId: number;
  kind: string;
  actorType: string;
  fromStatus: string | null;
  toStatus: string | null;
  body: string | null;
  createdAt: string;
}

interface ShowPayload {
  key: string;
  status: string;
  priority: number;
  title: string;
  description: string;
  parentId: number | null;
  blockedReason: string | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
  events: TimelineEvent[];
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
  const issue = JSON.parse(json.stdout) as {
    createdAt: string;
    updatedAt: string;
    events: Array<{ id: number; kind: string; actorType: string; createdAt: string }>;
  };
  const [createdEvent] = issue.events;
  assert.ok(createdEvent, "expected a created event in the show payload");

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
      "timeline:",
      `${createdEvent.id}\t${createdEvent.kind}\t${createdEvent.actorType}\t${createdEvent.createdAt}\t-`,
      "",
    ].join("\n"),
  );
});

test("issue comment then issue show render the comment in human and JSON form", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Comment target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const commented = await runCli(["issue", "comment", "TAC-1", "  Looks", "good  "]);
  assert.equal(commented.code, 0, commented.stderr);
  assert.equal(commented.stderr, "");
  assert.equal(commented.stdout, "commented on TAC-1 as human\n");

  const json = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout) as ShowPayload;
  assert.equal(payload.key, "TAC-1");
  assert.equal(payload.events.length, 2);

  const [createdEvent, commentEvent] = payload.events;
  assert.ok(createdEvent, "expected a created event in the timeline");
  assert.ok(commentEvent, "expected a comment event in the timeline");
  assert.equal(createdEvent.kind, "created");
  assert.equal(commentEvent.kind, "comment");
  assert.equal(commentEvent.issueId, createdEvent.issueId);
  assert.ok(commentEvent.id > createdEvent.id);
  assert.equal(commentEvent.actorType, "human");
  assert.equal(commentEvent.fromStatus, null);
  assert.equal(commentEvent.toStatus, null);
  assert.equal(commentEvent.body, "Looks good");
  assert.equal(new Date(commentEvent.createdAt).toISOString(), commentEvent.createdAt);

  const shown = await runCli(["issue", "show", "TAC-1"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(
    shown.stdout,
    [
      "key: TAC-1",
      "status: backlog",
      "priority: 3",
      "title: Comment target",
      "description: ",
      "parent: -",
      "blocked_reason: -",
      "claimed_by: -",
      `created_at: ${payload.createdAt}`,
      `updated_at: ${payload.updatedAt}`,
      "",
      "timeline:",
      `${createdEvent.id}\tcreated\thuman\t${createdEvent.createdAt}\t-`,
      `${commentEvent.id}\tcomment\thuman\t${commentEvent.createdAt}\tLooks good`,
      "",
    ].join("\n"),
  );
});

test("issue comment --json prints the appended comment event", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Comment target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const result = await runCli(["issue", "comment", "TAC-1", "Looks", "good", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const event = JSON.parse(result.stdout) as TimelineEvent;

  assert.deepEqual(
    Object.keys(event).sort(),
    [
      "actorType",
      "body",
      "createdAt",
      "fromStatus",
      "id",
      "issueId",
      "kind",
      "toStatus",
    ],
  );
  assert.equal(typeof event.id, "number");
  assert.equal(typeof event.issueId, "number");
  assert.equal(event.kind, "comment");
  assert.equal(event.actorType, "human");
  assert.equal(event.fromStatus, null);
  assert.equal(event.toStatus, null);
  assert.equal(event.body, "Looks good");
  assert.equal(new Date(event.createdAt).toISOString(), event.createdAt);
});

test("issue comment appends two actors' comments in insertion order", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Comment target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const human = await runCli(["issue", "comment", "TAC-1", "Human", "first"]);
  assert.equal(human.code, 0, human.stderr);
  assert.equal(human.stdout, "commented on TAC-1 as human\n");

  const agent = await runCli([
    "issue",
    "comment",
    "TAC-1",
    "Agent",
    "second",
    "--actor",
    "agent",
  ]);
  assert.equal(agent.code, 0, agent.stderr);
  assert.equal(agent.stdout, "commented on TAC-1 as agent\n");

  const json = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout) as ShowPayload;

  assert.deepEqual(
    payload.events.map((event) => event.kind),
    ["created", "comment", "comment"],
  );
  const ids = payload.events.map((event) => event.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

  assert.deepEqual(
    payload.events.slice(1).map((event) => [event.actorType, event.body]),
    [
      ["human", "Human first"],
      ["agent", "Agent second"],
    ],
  );
});

test("issue comment with an empty or blank body exits 1 with a validation error", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Comment target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  for (const body of [[""], ["   "]]) {
    const result = await runCli(["issue", "comment", "TAC-1", ...body]);
    assert.equal(result.code, 1, JSON.stringify(body));
    assert.match(result.stderr, /^validation: /);
    assert.equal(result.stdout, "");
  }

  const json = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout) as ShowPayload;
  assert.deepEqual(
    payload.events.map((event) => event.kind),
    ["created"],
  );
});

test("issue comment with an invalid --actor exits 1", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Comment target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const result = await runCli([
    "issue",
    "comment",
    "TAC-1",
    "Hello",
    "--actor",
    "robot",
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^validation: /);
  assert.equal(result.stdout, "");
});
