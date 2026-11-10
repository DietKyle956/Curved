import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";
import { createIssue } from "../src/services/issues.ts";
import { setIssueLabels } from "../src/services/labels.ts";
import { createProject } from "../src/services/projects.ts";
import { addRelation } from "../src/services/relations.ts";

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
  labels: string[];
  relations: { blocks: string[]; blockedBy: string[] };
  blockedReason: string | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
  events: TimelineEvent[];
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const child = spawn(process.execPath, ["src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CURVED_AGENT_TOKEN: "",
      DATABASE_URL: testDb.databaseUrl,
      ...env,
    },
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
  assert.equal(listed.stdout, "TAC-1\tbacklog\t3\tFix the flux capacitor\t-\n");

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
      "labels: -",
      "blocks: -",
      "blocked_by: -",
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
      "labels: -",
      "blocks: -",
      "blocked_by: -",
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

test("issue show renders labels and relations seeded through the service layer", async () => {
  await createProject(testDb.db, { key: "TAC", name: "Tac" });
  await createIssue(testDb.db, { project: "TAC", title: "Blocked work" });
  await createIssue(testDb.db, { project: "TAC", title: "Blocking work" });
  await setIssueLabels(testDb.db, { key: "TAC-1", labels: ["ui", "bug"] });
  await addRelation(testDb.db, { blocked: "TAC-1", blocking: "TAC-2" });

  const blocked = await runCli(["issue", "show", "TAC-1"]);
  assert.equal(blocked.code, 0, blocked.stderr);
  assert.ok(blocked.stdout.includes("\nlabels: bug, ui\n"), blocked.stdout);
  assert.ok(blocked.stdout.includes("\nblocks: -\n"), blocked.stdout);
  assert.ok(blocked.stdout.includes("\nblocked_by: TAC-2\n"), blocked.stdout);

  const blocking = await runCli(["issue", "show", "TAC-2"]);
  assert.equal(blocking.code, 0, blocking.stderr);
  assert.ok(blocking.stdout.includes("\nlabels: -\n"), blocking.stdout);
  assert.ok(blocking.stdout.includes("\nblocks: TAC-1\n"), blocking.stdout);
  assert.ok(blocking.stdout.includes("\nblocked_by: -\n"), blocking.stdout);

  const json = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout) as ShowPayload;
  assert.deepEqual(payload.labels, ["bug", "ui"]);
  assert.deepEqual(payload.relations, { blocks: [], blockedBy: ["TAC-2"] });
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

  const registered = await runCli(["agent", "add", "agent-1", "--json"]);
  assert.equal(registered.code, 0, registered.stderr);

  const agent = await runCli([
    "issue",
    "comment",
    "TAC-1",
    "Agent",
    "second",
    "--actor",
    "agent",
    "--agent",
    "agent-1",
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

test("issue move updates status and reports allowed transitions", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Move target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const moved = await runCli(["issue", "move", "TAC-1", "todo"]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(moved.stdout, "moved TAC-1 to todo\n");

  const shown = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  const shownPayload = JSON.parse(shown.stdout) as ShowPayload & {
    allowedTransitions: string[];
  };
  assert.equal(shownPayload.status, "todo");
  assert.deepEqual(shownPayload.allowedTransitions, ["backlog", "in_progress"]);

  // Moving an issue to its current status has no legal edge, so return to
  // backlog first and exercise the JSON form of the same move.
  const reverted = await runCli(["issue", "move", "TAC-1", "backlog"]);
  assert.equal(reverted.code, 0, reverted.stderr);
  assert.equal(reverted.stdout, "moved TAC-1 to backlog\n");

  const json = await runCli(["issue", "move", "TAC-1", "todo", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout) as {
    key: string;
    status: string;
    allowedTransitions: string[];
  };
  assert.equal(payload.key, "TAC-1");
  assert.equal(payload.status, "todo");
  assert.deepEqual(payload.allowedTransitions, ["backlog", "in_progress"]);
});

test("issue move resolves padded keys in the human output", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Move target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const result = await runCli(["issue", "move", "TAC-001", "todo"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "moved TAC-1 to todo\n");
});

test("issue move along an illegal edge exits 1 with an illegal_transition error", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Move target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const result = await runCli(["issue", "move", "TAC-1", "done"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^illegal_transition: /);
  assert.equal(result.stdout, "");

  const shown = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  const payload = JSON.parse(shown.stdout) as ShowPayload;
  assert.equal(payload.status, "backlog");
  assert.deepEqual(
    payload.events.map((event) => event.kind),
    ["created"],
  );
});

test("issue move without a target status exits 2 with the usage block", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Move target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const result = await runCli(["issue", "move", "TAC-1"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage: curved <command> \[options\]/);
  assert.equal(result.stdout, "");
});

test("issue move --body records a status event with the transition", async () => {
  const project = await runCli(["project", "add", "TAC", "Tac", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "TAC", "Move target", "--json"]);
  assert.equal(created.code, 0, created.stderr);

  const moved = await runCli([
    "issue",
    "move",
    "TAC-1",
    "todo",
    "--body",
    "starting work",
  ]);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(moved.stdout, "moved TAC-1 to todo\n");

  const json = await runCli(["issue", "show", "TAC-1", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout) as ShowPayload;
  assert.equal(payload.status, "todo");
  assert.equal(payload.events.length, 2);

  const [createdEvent, statusEvent] = payload.events;
  assert.ok(createdEvent, "expected a created event in the timeline");
  assert.ok(statusEvent, "expected a status event in the timeline");
  assert.equal(createdEvent.kind, "created");
  assert.equal(statusEvent.kind, "status");
  assert.equal(statusEvent.actorType, "human");
  assert.equal(statusEvent.body, "starting work");
  assert.equal(statusEvent.fromStatus, "backlog");
  assert.equal(statusEvent.toStatus, "todo");
});

interface IssueJson {
  id: number;
  key: string;
  status: string;
  priority: number;
  title: string;
  claimedBy: string | null;
  allowedTransitions: string[];
  createdAt: string;
  updatedAt: string;
}

interface ReadyQueue {
  ready: IssueJson[];
  busy: string | null;
}

test("agent add prints the pinned human output and a base64url token", async () => {
  const result = await runCli(["agent", "add", "alpha"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const match = /^created agent alpha\ntoken: (crv_[A-Za-z0-9_-]{32})\n$/.exec(
    result.stdout,
  );
  assert.ok(match, `unexpected stdout: ${JSON.stringify(result.stdout)}`);
});

test("agent add --json prints the created agent with its plaintext token", async () => {
  const result = await runCli(["agent", "add", "alpha", "--json"]);

  assert.equal(result.code, 0, result.stderr);
  const agent = JSON.parse(result.stdout) as {
    id: number;
    name: string;
    createdAt: string;
    token: string;
  };

  assert.deepEqual(
    Object.keys(agent).sort(),
    ["createdAt", "id", "name", "token"],
  );
  assert.equal(typeof agent.id, "number");
  assert.equal(agent.name, "alpha");
  assert.equal(new Date(agent.createdAt).toISOString(), agent.createdAt);
  assert.match(agent.token, /^crv_[A-Za-z0-9_-]{32}$/);
});

test("a duplicate agent add exits 1 with a duplicate error", async () => {
  const first = await runCli(["agent", "add", "alpha"]);
  assert.equal(first.code, 0, first.stderr);

  const result = await runCli(["agent", "add", "alpha"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^duplicate: /);
  assert.equal(result.stdout, "");
});

test("agent queue flow claims, reviews, and completes one issue", async () => {
  const project = await runCli(["project", "add", "SEQ", "Sequence", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli([
    "issue",
    "add",
    "SEQ",
    "Queue target",
    "--status",
    "todo",
    "--json",
  ]);
  assert.equal(created.code, 0, created.stderr);

  const added = await runCli(["agent", "add", "alpha", "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const { token } = JSON.parse(added.stdout) as { token: string };
  const env = { CURVED_AGENT_TOKEN: token };

  const ready = await runCli(["ready", "--json"], env);
  assert.equal(ready.code, 0, ready.stderr);
  const queue = JSON.parse(ready.stdout) as ReadyQueue;
  assert.deepEqual(
    queue.ready.map((issue) => issue.key),
    ["SEQ-1"],
  );
  assert.equal(queue.busy, null);

  const claimed = await runCli(["claim", "--json"], env);
  assert.equal(claimed.code, 0, claimed.stderr);
  const claimIssue = JSON.parse(claimed.stdout) as IssueJson;
  assert.equal(claimIssue.key, "SEQ-1");
  assert.equal(claimIssue.status, "in_progress");
  assert.equal(claimIssue.claimedBy, "alpha");
  assert.deepEqual(claimIssue.allowedTransitions, ["todo", "in_review"]);

  const claimTimeline = await runCli(["issue", "show", "SEQ-1", "--json"]);
  assert.equal(claimTimeline.code, 0, claimTimeline.stderr);
  const claimEvents = (JSON.parse(claimTimeline.stdout) as ShowPayload).events;
  assert.deepEqual(
    claimEvents.map((event) => event.kind),
    ["created", "claim"],
  );
  const claimEvent = claimEvents[1];
  assert.ok(claimEvent, "expected a claim event in the timeline");
  assert.equal(claimEvent.actorType, "agent");
  assert.equal(claimEvent.fromStatus, "todo");
  assert.equal(claimEvent.toStatus, "in_progress");

  const busyClaim = await runCli(["claim", "--json"], env);
  assert.equal(busyClaim.code, 1);
  assert.match(busyClaim.stderr, /^agent_busy: .*SEQ-1/);
  assert.equal(busyClaim.stdout, "");

  const busyReady = await runCli(["ready", "--json"], env);
  assert.equal(busyReady.code, 0, busyReady.stderr);
  const busyQueue = JSON.parse(busyReady.stdout) as ReadyQueue;
  assert.deepEqual(busyQueue.ready, []);
  assert.equal(busyQueue.busy, "SEQ-1");

  const reviewed = await runCli(
    ["review", "SEQ-1", "ready", "for", "review", "--json"],
    env,
  );
  assert.equal(reviewed.code, 0, reviewed.stderr);
  const reviewedIssue = JSON.parse(reviewed.stdout) as IssueJson;
  assert.equal(reviewedIssue.key, "SEQ-1");
  assert.equal(reviewedIssue.status, "in_review");
  assert.equal(reviewedIssue.claimedBy, "alpha");

  const reviewTimeline = await runCli(["issue", "show", "SEQ-1", "--json"]);
  assert.equal(reviewTimeline.code, 0, reviewTimeline.stderr);
  const reviewEvents = (JSON.parse(reviewTimeline.stdout) as ShowPayload).events;
  assert.deepEqual(
    reviewEvents.map((event) => event.kind),
    ["created", "claim", "review_submitted"],
  );
  const reviewEvent = reviewEvents[2];
  assert.ok(reviewEvent, "expected a review_submitted event in the timeline");
  assert.equal(reviewEvent.actorType, "agent");
  assert.equal(reviewEvent.body, "ready for review");
  assert.equal(reviewEvent.fromStatus, "in_progress");
  assert.equal(reviewEvent.toStatus, "in_review");

  const busyAgain = await runCli(["claim", "--json"], env);
  assert.equal(busyAgain.code, 1);
  assert.match(busyAgain.stderr, /^agent_busy: .*SEQ-1/);
  assert.equal(busyAgain.stdout, "");

  const done = await runCli(["issue", "move", "SEQ-1", "done"]);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.stdout, "moved SEQ-1 to done\n");

  const emptyClaim = await runCli(["claim", "--json"], env);
  assert.equal(emptyClaim.code, 1);
  assert.match(emptyClaim.stderr, /^no_ready_issue: /);
  assert.equal(emptyClaim.stdout, "");
});

test("queue commands reject missing and invalid agent tokens", async () => {
  const project = await runCli(["project", "add", "AUT", "Auth", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli([
    "issue",
    "add",
    "AUT",
    "Auth target",
    "--status",
    "todo",
    "--json",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const added = await runCli(["agent", "add", "alpha", "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const { token } = JSON.parse(added.stdout) as { token: string };

  const missing = await runCli(["claim"], { CURVED_AGENT_TOKEN: "" });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^not_authenticated: /);
  assert.equal(missing.stdout, "");

  const unchanged = await runCli(["issue", "show", "AUT-1", "--json"]);
  assert.equal(unchanged.code, 0, unchanged.stderr);
  const unchangedIssue = JSON.parse(unchanged.stdout) as IssueJson;
  assert.equal(unchangedIssue.status, "todo");
  assert.equal(unchangedIssue.claimedBy, null);

  const invalid = await runCli(["claim"], { CURVED_AGENT_TOKEN: "crv_invalid" });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /^not_authenticated: /);
  assert.equal(invalid.stdout, "");

  const readyWithoutToken = await runCli(["ready"]);
  assert.equal(readyWithoutToken.code, 1);
  assert.match(readyWithoutToken.stderr, /^not_authenticated: /);
  assert.equal(readyWithoutToken.stdout, "");

  const humanReady = await runCli(["ready", "--human", "--json"]);
  assert.equal(humanReady.code, 0, humanReady.stderr);
  const queue = JSON.parse(humanReady.stdout) as ReadyQueue;
  assert.equal(queue.busy, null);
  assert.deepEqual(
    queue.ready.map((issue) => issue.key),
    ["AUT-1"],
  );

  const authenticated = await runCli(["claim", "--json"], {
    CURVED_AGENT_TOKEN: token,
  });
  assert.equal(authenticated.code, 0, authenticated.stderr);
});

test("ready --human, claim, and release print the pinned human formats", async () => {
  const project = await runCli(["project", "add", "HUM", "Human", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli([
    "issue",
    "add",
    "HUM",
    "Alpha task",
    "--status",
    "todo",
    "--json",
  ]);
  assert.equal(created.code, 0, created.stderr);

  const ready = await runCli(["ready", "--human"]);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(ready.stdout, "HUM-1\t3\ttodo\tAlpha task\nbusy: -\n");

  const added = await runCli(["agent", "add", "alpha", "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const { token } = JSON.parse(added.stdout) as { token: string };
  const env = { CURVED_AGENT_TOKEN: token };

  const second = await runCli([
    "issue",
    "add",
    "HUM",
    "Beta task",
    "--status",
    "todo",
    "--json",
  ]);
  assert.equal(second.code, 0, second.stderr);

  const claimed = await runCli(["claim"], env);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(claimed.stdout, "claimed HUM-1\n");

  const released = await runCli(["release", "HUM-1", "--json"], env);
  assert.equal(released.code, 0, released.stderr);
  const releasedIssue = JSON.parse(released.stdout) as IssueJson;
  assert.equal(releasedIssue.key, "HUM-1");
  assert.equal(releasedIssue.status, "todo");
  assert.equal(releasedIssue.claimedBy, null);

  const timeline = await runCli(["issue", "show", "HUM-1", "--json"]);
  assert.equal(timeline.code, 0, timeline.stderr);
  const events = (JSON.parse(timeline.stdout) as ShowPayload).events;
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "claim", "release"],
  );
  const releaseEvent = events[2];
  assert.ok(releaseEvent, "expected a release event in the timeline");
  assert.equal(releaseEvent.actorType, "agent");
  assert.equal(releaseEvent.fromStatus, "in_progress");
  assert.equal(releaseEvent.toStatus, "todo");

  const reclaimed = await runCli(["claim"], env);
  assert.equal(reclaimed.code, 0, reclaimed.stderr);
  assert.equal(reclaimed.stdout, "claimed HUM-1\n");

  const humanRelease = await runCli(["release", "HUM-1"], env);
  assert.equal(humanRelease.code, 0, humanRelease.stderr);
  assert.equal(humanRelease.stdout, "released HUM-1\n");
});

test("review without a summary word is a usage error", async () => {
  const project = await runCli(["project", "add", "REV", "Review", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli([
    "issue",
    "add",
    "REV",
    "Review target",
    "--status",
    "todo",
    "--json",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const added = await runCli(["agent", "add", "alpha", "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const { token } = JSON.parse(added.stdout) as { token: string };
  const env = { CURVED_AGENT_TOKEN: token };
  const claimed = await runCli(["claim", "--json"], env);
  assert.equal(claimed.code, 0, claimed.stderr);

  const result = await runCli(["review", "REV-1"], env);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage: curved <command> \[options\]/);
  assert.equal(result.stdout, "");
});

test("issue comment requires a registered agent for the agent actor", async () => {
  const project = await runCli(["project", "add", "CMT", "Comment", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli(["issue", "add", "CMT", "Comment target", "--json"]);
  assert.equal(created.code, 0, created.stderr);
  const added = await runCli(["agent", "add", "alpha", "--json"]);
  assert.equal(added.code, 0, added.stderr);

  const commented = await runCli([
    "issue",
    "comment",
    "CMT-1",
    "note",
    "--actor",
    "agent",
    "--agent",
    "alpha",
  ]);
  assert.equal(commented.code, 0, commented.stderr);
  assert.equal(commented.stdout, "commented on CMT-1 as agent\n");

  const unknown = await runCli([
    "issue",
    "comment",
    "CMT-1",
    "note",
    "--actor",
    "agent",
    "--agent",
    "beta",
  ]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^not_found: /);
  assert.equal(unknown.stdout, "");
});

test("blocking an issue records a reason and unblocking restores readiness", async () => {
  const project = await runCli(["project", "add", "BLK", "Blocking", "--json"]);
  assert.equal(project.code, 0, project.stderr);
  const created = await runCli([
    "issue",
    "add",
    "BLK",
    "Blocking target",
    "--status",
    "todo",
    "--json",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const added = await runCli(["agent", "add", "alpha", "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const { token } = JSON.parse(added.stdout) as { token: string };
  const env = { CURVED_AGENT_TOKEN: token };

  const claimed = await runCli(["claim", "BLK"], env);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(claimed.stdout, "claimed BLK-1\n");

  const blocked = await runCli(
    ["issue", "block", "BLK-1", "waiting", "on", "design", "--json"],
    env,
  );
  assert.equal(blocked.code, 0, blocked.stderr);
  const blockedIssue = JSON.parse(blocked.stdout) as {
    key: string;
    status: string;
    blockedReason: string | null;
    claimedBy: string | null;
  };
  assert.equal(blockedIssue.key, "BLK-1");
  assert.equal(blockedIssue.status, "todo");
  assert.equal(blockedIssue.blockedReason, "waiting on design");
  assert.equal(blockedIssue.claimedBy, null);

  const timeline = await runCli(["issue", "show", "BLK-1", "--json"]);
  assert.equal(timeline.code, 0, timeline.stderr);
  const events = (JSON.parse(timeline.stdout) as ShowPayload).events;
  const blockEvent = events.at(-1);
  assert.ok(blockEvent, "expected a blocked event in the timeline");
  assert.equal(blockEvent.kind, "blocked");
  assert.equal(blockEvent.actorType, "agent");
  assert.equal(blockEvent.body, "waiting on design");
  assert.equal(blockEvent.fromStatus, "in_progress");
  assert.equal(blockEvent.toStatus, "todo");

  const listed = await runCli(["issue", "list", "BLK"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(
    listed.stdout,
    "BLK-1\ttodo\t3\tBlocking target\twaiting on design\n",
  );

  const shown = await runCli(["issue", "show", "BLK-1"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(
    shown.stdout.includes("blocked_reason: waiting on design"),
    `unexpected stdout: ${JSON.stringify(shown.stdout)}`,
  );

  const readyWhileBlocked = await runCli(["ready", "BLK"], env);
  assert.equal(readyWhileBlocked.code, 0, readyWhileBlocked.stderr);
  assert.equal(readyWhileBlocked.stdout, "busy: -\n");

  const claimWhileBlocked = await runCli(["claim", "BLK"], env);
  assert.equal(claimWhileBlocked.code, 1);
  assert.match(claimWhileBlocked.stderr, /^no_ready_issue: /);
  assert.equal(claimWhileBlocked.stdout, "");

  const unblocked = await runCli(["issue", "unblock", "BLK-1", "--json"]);
  assert.equal(unblocked.code, 0, unblocked.stderr);
  const unblockedIssue = JSON.parse(unblocked.stdout) as {
    status: string;
    blockedReason: string | null;
  };
  assert.equal(unblockedIssue.status, "todo");
  assert.equal(unblockedIssue.blockedReason, null);

  const readyAgain = await runCli(["ready", "BLK"], env);
  assert.equal(readyAgain.code, 0, readyAgain.stderr);
  assert.equal(readyAgain.stdout, "BLK-1\t3\ttodo\tBlocking target\nbusy: -\n");
});

test("block and unblock reject missing credentials, wrong actors, wrong status, and blank reasons", async () => {
  const added = await runCli(["agent", "add", "alpha", "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const { token } = JSON.parse(added.stdout) as { token: string };
  const env = { CURVED_AGENT_TOKEN: token };

  const authProject = await runCli(["project", "add", "ATH", "Auth", "--json"]);
  assert.equal(authProject.code, 0, authProject.stderr);
  const authIssue = await runCli(["issue", "add", "ATH", "Auth target", "--json"]);
  assert.equal(authIssue.code, 0, authIssue.stderr);

  const withoutToken = await runCli(["issue", "block", "ATH-1", "because"], {
    CURVED_AGENT_TOKEN: "",
  });
  assert.equal(withoutToken.code, 1);
  assert.match(withoutToken.stderr, /^not_authenticated: /);
  assert.equal(withoutToken.stdout, "");

  const unblockProject = await runCli(["project", "add", "UNB", "Unblock", "--json"]);
  assert.equal(unblockProject.code, 0, unblockProject.stderr);
  const unblockIssue = await runCli([
    "issue",
    "add",
    "UNB",
    "Unblock target",
    "--json",
  ]);
  assert.equal(unblockIssue.code, 0, unblockIssue.stderr);

  const forbiddenUnblock = await runCli([
    "issue",
    "unblock",
    "UNB-1",
    "--actor",
    "agent",
    "--agent",
    "alpha",
  ]);
  assert.equal(forbiddenUnblock.code, 1);
  assert.match(forbiddenUnblock.stderr, /^forbidden_transition: /);
  assert.equal(forbiddenUnblock.stdout, "");

  const statusProject = await runCli(["project", "add", "WST", "Wrong", "--json"]);
  assert.equal(statusProject.code, 0, statusProject.stderr);
  const statusIssue = await runCli([
    "issue",
    "add",
    "WST",
    "Wrong status target",
    "--status",
    "todo",
    "--json",
  ]);
  assert.equal(statusIssue.code, 0, statusIssue.stderr);
  const statusClaim = await runCli(["claim", "WST"], env);
  assert.equal(statusClaim.code, 0, statusClaim.stderr);
  const statusReview = await runCli(["review", "WST-1", "ready", "--json"], env);
  assert.equal(statusReview.code, 0, statusReview.stderr);

  const illegalBlock = await runCli(
    ["issue", "block", "WST-1", "not in progress"],
    env,
  );
  assert.equal(illegalBlock.code, 1);
  assert.match(illegalBlock.stderr, /^illegal_transition: /);
  assert.equal(illegalBlock.stdout, "");

  const blankProject = await runCli(["project", "add", "VAL", "Blank", "--json"]);
  assert.equal(blankProject.code, 0, blankProject.stderr);
  const blankIssue = await runCli(["issue", "add", "VAL", "Blank target", "--json"]);
  assert.equal(blankIssue.code, 0, blankIssue.stderr);

  const blankReason = await runCli(["issue", "block", "VAL-1", "   "], env);
  assert.equal(blankReason.code, 1);
  assert.match(blankReason.stderr, /^validation: /);
  assert.equal(blankReason.stdout, "");
});
