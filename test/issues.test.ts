import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ServiceError, type ErrorCode } from "../src/errors.ts";
import { listEvents } from "../src/services/events.ts";
import {
  createIssue,
  getIssue,
  listIssues,
  type CreateIssueInput,
} from "../src/services/issues.ts";
import { createProject } from "../src/services/projects.ts";
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
  const project = await createProject(testDb.db, { key, name: key });
  return project.id;
}

test("createIssue applies defaults and stores a trimmed title", async () => {
  const projectId = await seedProject("TAC");

  const issue = await createIssue(testDb.db, {
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
  assert.equal(issue.blockedReason, null);
  assert.equal(issue.claimedBy, null);
  assertIsoTimestamp(issue.createdAt);
  assertIsoTimestamp(issue.updatedAt);
});

test("createIssue appends exactly one created event", async () => {
  await seedProject("TAC");
  const issue = await createIssue(testDb.db, {
    project: "TAC",
    title: "Log the creation",
  });

  const events = await listEvents(testDb.db, issue.id);
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
      createIssue(testDb.db, input),
      rejectsWithServiceCode("validation"),
      label,
    );
  }
});

test("createIssue rejects an unknown project and an unknown parent", async () => {
  await seedProject("TAC");

  await assert.rejects(
    createIssue(testDb.db, { project: "ZZZ", title: "Missing project" }),
    rejectsWithServiceCode("not_found"),
  );

  await assert.rejects(
    createIssue(testDb.db, { project: "TAC", title: "Missing parent", parent: "TAC-99" }),
    rejectsWithServiceCode("not_found"),
  );
});

test("createIssue honors explicit status, priority, and a padded parent key", async () => {
  await seedProject("TAC");
  const parent = await createIssue(testDb.db, { project: "TAC", title: "Parent" });

  const child = await createIssue(testDb.db, {
    project: "TAC",
    title: "Child",
    status: "todo",
    priority: 1,
    parent: "TAC-0001",
  });

  assert.equal(child.status, "todo");
  assert.equal(child.priority, 1);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.number, 2);
});

test("25 concurrent createIssue calls allocate 25 distinct sequential keys", async () => {
  await seedProject("TAC");

  const issues = await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      createIssue(testDb.db, { project: "TAC", title: `Concurrent ${index + 1}` }),
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
    await createIssue(testDb.db, { project: "TAC", title: `Issue ${index}` });
  }

  const issue = await getIssue(testDb.db, "TAC-014");
  assert.equal(issue.key, "TAC-14");
  assert.equal(issue.number, 14);

  await assert.rejects(
    getIssue(testDb.db, "tac-1"),
    rejectsWithServiceCode("validation"),
  );
  await assert.rejects(
    getIssue(testDb.db, "TAC-99"),
    rejectsWithServiceCode("not_found"),
  );
});

test("listIssues orders by project key then number and filters by project", async () => {
  await seedProject("TAC");
  await seedProject("AAA");

  await createIssue(testDb.db, { project: "TAC", title: "TAC first" });
  await createIssue(testDb.db, { project: "TAC", title: "TAC second" });
  await createIssue(testDb.db, { project: "AAA", title: "AAA first" });

  const all = await listIssues(testDb.db);
  assert.deepEqual(
    all.map((issue) => issue.key),
    ["AAA-1", "TAC-1", "TAC-2"],
  );

  const tac = await listIssues(testDb.db, { project: "TAC" });
  assert.deepEqual(
    tac.map((issue) => issue.key),
    ["TAC-1", "TAC-2"],
  );

  await assert.rejects(
    listIssues(testDb.db, { project: "ZZZ" }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    listIssues(testDb.db, { project: "tac" }),
    rejectsWithServiceCode("validation"),
  );
});
