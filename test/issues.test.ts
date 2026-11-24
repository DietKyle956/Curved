import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ServiceError, type ErrorCode } from "../src/domain/errors.ts";
import {
  createIssue,
  getIssue,
  getIssueTimeline,
  listIssues,
  updateIssue,
  type CreateIssueInput,
} from "../src/application/issues.ts";
import { createProject } from "../src/application/projects.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

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

function rejectsWithServiceCode(code: ErrorCode): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function assertIsoTimestamp(value: string): void {
  assert.equal(new Date(value).toISOString(), value);
}

async function seedProject(key: string): Promise<number> {
  const project = await createProject(testDb.ports, { key, name: key });
  return project.id;
}

test("createIssue applies defaults and stores a trimmed title", async () => {
  const projectId = await seedProject("TAC");

  const issue = await createIssue(testDb.ports, {
    project: "TAC",
    title: "  Fix the thing  ",
    description: "details",
  });

  assert.equal(issue.key, "TAC-1");
  assert.equal(issue.number, 1);
  assert.equal(issue.projectKey, "TAC");
  assert.equal(issue.projectId, projectId);
  assert.equal(issue.title, "Fix the thing");
  assert.equal(issue.description, "details");
  assert.equal(issue.status, "backlog");
  assert.equal(issue.priority, 3);
  assert.equal(issue.parentId, null);
  assert.equal(issue.parentKey, null);
  assert.equal(issue.blockedReason, null);
  assert.equal(issue.claimedBy, null);
  assertIsoTimestamp(issue.createdAt);
  assertIsoTimestamp(issue.updatedAt);
});

test("createIssue appends exactly one created event", async () => {
  await seedProject("TAC");
  const issue = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Log the creation",
  });

  const events = await testDb.ports.events.list(issue.id);
  assert.equal(events.length, 1);

  const [event] = events;
  assert.ok(event, "expected a created event");
  assert.equal(event.kind, "created");
  assert.equal(event.issueId, issue.id);
  assert.equal(event.actorType, "human");
  assert.equal(event.fromStatus, null);
  assert.equal(event.toStatus, "backlog");
  assert.equal(event.body, null);
  assertIsoTimestamp(event.createdAt);
});

test("createIssue rejects invalid input with validation ServiceErrors", async () => {
  await seedProject("TAC");

  const cases: Array<[string, CreateIssueInput]> = [
    ["empty title", { project: "TAC", title: "" }],
    ["blank title", { project: "TAC", title: "   " }],
    ["501-character title", { project: "TAC", title: "x".repeat(501) }],
    ["priority 0", { project: "TAC", title: "Priority", priority: 0 }],
    ["priority 5", { project: "TAC", title: "Priority", priority: 5 }],
    ["fractional priority", { project: "TAC", title: "Priority", priority: 2.5 }],
    ["unknown status", { project: "TAC", title: "Status", status: "nope" }],
    ["unknown actor", { project: "TAC", title: "Actor", actor: "robot" }],
    ["malformed project", { project: "tac", title: "Project" }],
  ];

  for (const [label, input] of cases) {
    await assert.rejects(
      createIssue(testDb.ports, input),
      rejectsWithServiceCode("validation"),
      label,
    );
  }
});

test("createIssue rejects an unknown project and an unknown parent", async () => {
  await seedProject("TAC");

  await assert.rejects(
    createIssue(testDb.ports, { project: "ZZZ", title: "Missing project" }),
    rejectsWithServiceCode("not_found"),
  );

  await assert.rejects(
    createIssue(testDb.ports, { project: "TAC", title: "Missing parent", parent: "TAC-99" }),
    rejectsWithServiceCode("not_found"),
  );
});

test("createIssue honors explicit status, priority, and a padded parent key", async () => {
  await seedProject("TAC");
  const parent = await createIssue(testDb.ports, { project: "TAC", title: "Parent" });

  const child = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Child",
    status: "todo",
    priority: 1,
    parent: "TAC-0001",
  });

  assert.equal(child.status, "todo");
  assert.equal(child.priority, 1);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.parentKey, parent.key);
  assert.equal(parent.parentKey, null);
  assert.equal(child.number, 2);
});

test("createIssue rejects a parent from another project", async () => {
  await seedProject("TAC");
  await seedProject("OPS");

  const parent = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Cross-project parent",
  });

  await assert.rejects(
    createIssue(testDb.ports, {
      project: "OPS",
      title: "Cross-project child",
      parent: parent.key,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
      assert.equal(error.code, "validation");
      assert.match(error.message, /is in project "TAC", not "OPS"/);
      return true;
    },
  );

  const ops = await listIssues(testDb.ports, { project: "OPS" });
  assert.deepEqual(ops, []);
});

test("getIssueTimeline lists direct children in ascending order", async () => {
  await seedProject("TAC");

  const parent = await createIssue(testDb.ports, { project: "TAC", title: "Parent" });
  const first = await createIssue(testDb.ports, {
    project: "TAC",
    title: "First child",
    parent: parent.key,
  });
  const second = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Second child",
    parent: parent.key,
  });

  const timeline = await getIssueTimeline(testDb.ports, parent.key);
  assert.deepEqual(timeline.children, [
    { key: first.key, title: first.title, status: "backlog" },
    { key: second.key, title: second.title, status: "backlog" },
  ]);

  const created = await listIssues(testDb.ports, { project: "TAC" });
  const childRow = created.find((issue) => issue.key === second.key);
  assert.ok(childRow, "expected the child in the project listing");
  assert.equal(childRow.parentKey, parent.key);
  assert.equal(childRow.parentId, parent.id);
});

test("25 concurrent createIssue calls allocate 25 distinct sequential keys", async () => {
  await seedProject("TAC");

  const issues = await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      createIssue(testDb.ports, { project: "TAC", title: `Concurrent ${index + 1}` }),
    ),
  );

  const numbers = issues.map((issue) => issue.number).sort((a, b) => a - b);
  assert.deepEqual(
    numbers,
    Array.from({ length: 25 }, (_, index) => index + 1),
  );

  const keys = issues.map((issue) => issue.key);
  assert.equal(new Set(keys).size, 25);
  assert.deepEqual(
    issues
      .slice()
      .sort((a, b) => a.number - b.number)
      .map((issue) => issue.key),
    Array.from({ length: 25 }, (_, index) => `TAC-${index + 1}`),
  );
});

test("getIssue accepts padded keys and rejects malformed or unknown keys", async () => {
  await seedProject("TAC");
  for (let index = 1; index <= 14; index += 1) {
    await createIssue(testDb.ports, { project: "TAC", title: `Issue ${index}` });
  }

  const issue = await getIssue(testDb.ports, "TAC-014");
  assert.equal(issue.key, "TAC-14");
  assert.equal(issue.number, 14);

  await assert.rejects(
    getIssue(testDb.ports, "tac-1"),
    rejectsWithServiceCode("validation"),
  );
  await assert.rejects(
    getIssue(testDb.ports, "TAC-99"),
    rejectsWithServiceCode("not_found"),
  );
});

test("getIssueTimeline returns the issue and exactly its created event", async () => {
  await seedProject("TAC");
  const created = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Timeline target",
  });

  const timeline = await getIssueTimeline(testDb.ports, created.key);

  assert.deepEqual(timeline.issue, created);
  assert.equal(timeline.events.length, 1);

  const [event] = timeline.events;
  assert.ok(event, "expected a created event");
  assert.equal(event.issueId, created.id);
  assert.equal(event.kind, "created");
  assert.equal(event.actorType, "human");
  assert.equal(event.fromStatus, null);
  assert.equal(event.toStatus, "backlog");
  assert.equal(event.body, null);
  assertIsoTimestamp(event.createdAt);

  await assert.rejects(
    getIssueTimeline(testDb.ports, "TAC-99"),
    rejectsWithServiceCode("not_found"),
  );
});

test("listIssues orders by project key then number and filters by project", async () => {
  await seedProject("TAC");
  await seedProject("AAA");

  await createIssue(testDb.ports, { project: "TAC", title: "TAC first" });
  await createIssue(testDb.ports, { project: "TAC", title: "TAC second" });
  await createIssue(testDb.ports, { project: "AAA", title: "AAA first" });

  const all = await listIssues(testDb.ports);
  assert.deepEqual(
    all.map((issue) => issue.key),
    ["AAA-1", "TAC-1", "TAC-2"],
  );

  const tac = await listIssues(testDb.ports, { project: "TAC" });
  assert.deepEqual(
    tac.map((issue) => issue.key),
    ["TAC-1", "TAC-2"],
  );

  await assert.rejects(
    listIssues(testDb.ports, { project: "ZZZ" }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    listIssues(testDb.ports, { project: "tac" }),
    rejectsWithServiceCode("validation"),
  );
});

test("listIssues filters by status and rejects an invalid status", async () => {
  await seedProject("TAC");
  await seedProject("AAA");

  const backlog = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Backlog issue",
  });
  await createIssue(testDb.ports, { project: "TAC", title: "Todo issue", status: "todo" });
  await createIssue(testDb.ports, { project: "AAA", title: "AAA todo", status: "todo" });

  const todo = await listIssues(testDb.ports, { status: "todo" });
  assert.deepEqual(
    todo.map((issue) => issue.key),
    ["AAA-1", "TAC-2"],
  );

  const tacTodo = await listIssues(testDb.ports, { project: "TAC", status: "todo" });
  assert.deepEqual(
    tacTodo.map((issue) => issue.key),
    ["TAC-2"],
  );

  const backlogIssues = await listIssues(testDb.ports, { status: "backlog" });
  assert.deepEqual(
    backlogIssues.map((issue) => issue.key),
    [backlog.key],
  );

  await assert.rejects(
    listIssues(testDb.ports, { status: "nope" }),
    rejectsWithServiceCode("validation"),
  );
});

test("updateIssue trims the title, persists it, and appends no event", async () => {
  await seedProject("TAC");
  const created = await createIssue(testDb.ports, { project: "TAC", title: "Original" });

  const updated = await updateIssue(testDb.ports, {
    key: created.key,
    title: "  Revised title  ",
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.key, created.key);
  assert.equal(updated.title, "Revised title");
  assert.equal(updated.description, created.description);
  assertIsoTimestamp(updated.updatedAt);

  const reloaded = await getIssue(testDb.ports, created.key);
  assert.equal(reloaded.title, "Revised title");

  const events = await testDb.ports.events.list(created.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "created");
});

test("updateIssue stores an empty description and a new priority", async () => {
  await seedProject("TAC");
  const created = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Editable fields",
    description: "old description",
  });

  const updated = await updateIssue(testDb.ports, {
    key: "TAC-0001",
    description: "",
    priority: 1,
  });

  assert.equal(updated.description, "");
  assert.equal(updated.priority, 1);
  assert.equal(updated.title, "Editable fields");

  const reloaded = await getIssue(testDb.ports, created.key);
  assert.equal(reloaded.description, "");
  assert.equal(reloaded.priority, 1);
});

test("updateIssue rejects non-human actors with forbidden_transition", async () => {
  await seedProject("TAC");
  const created = await createIssue(testDb.ports, { project: "TAC", title: "Locked" });

  await assert.rejects(
    updateIssue(testDb.ports, {
      key: created.key,
      title: "Agent edit",
      actor: "agent",
      agent: "bot",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );
  await assert.rejects(
    updateIssue(testDb.ports, { key: created.key, title: "System edit", actor: "system" }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const unchanged = await getIssue(testDb.ports, created.key);
  assert.equal(unchanged.title, "Locked");
});

test("updateIssue requires at least one editable field", async () => {
  await seedProject("TAC");
  const created = await createIssue(testDb.ports, { project: "TAC", title: "No fields" });

  await assert.rejects(
    updateIssue(testDb.ports, { key: created.key }),
    rejectsWithServiceCode("validation"),
  );
});

test("updateIssue rejects an unknown key", async () => {
  await seedProject("TAC");

  await assert.rejects(
    updateIssue(testDb.ports, { key: "TAC-99", title: "Missing" }),
    rejectsWithServiceCode("not_found"),
  );
});
