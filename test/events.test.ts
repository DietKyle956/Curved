import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { pgErrorCode } from "../src/db.ts";
import { appendEvent, listEvents } from "../src/services/events.ts";
import { createIssue } from "../src/services/issues.ts";
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

function assertIsoTimestamp(value: string): void {
  assert.equal(new Date(value).toISOString(), value);
}

async function seedIssue(): Promise<number> {
  await createProject(testDb.db, { key: "TAC", name: "Tactics" });
  const issue = await createIssue(testDb.db, { project: "TAC", title: "Event target" });
  return issue.id;
}

test("appendEvent stores comment and status events and listEvents returns them ascending by id", async () => {
  const issueId = await seedIssue();

  const comment = await appendEvent(testDb.db, {
    issueId,
    kind: "comment",
    actorType: "human",
    body: "looks good",
  });
  const status = await appendEvent(testDb.db, {
    issueId,
    kind: "status",
    actorType: "agent",
    fromStatus: "backlog",
    toStatus: "todo",
  });

  const events = await listEvents(testDb.db, issueId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "comment", "status"],
  );

  const ids = events.map((event) => event.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(comment.id < status.id);

  const commentEvent = events.find((event) => event.id === comment.id);
  assert.ok(commentEvent, "comment event missing from history");
  assert.equal(commentEvent.issueId, issueId);
  assert.equal(commentEvent.kind, "comment");
  assert.equal(commentEvent.actorType, "human");
  assert.equal(commentEvent.fromStatus, null);
  assert.equal(commentEvent.toStatus, null);
  assert.equal(commentEvent.body, "looks good");
  assertIsoTimestamp(commentEvent.createdAt);

  const statusEvent = events.find((event) => event.id === status.id);
  assert.ok(statusEvent, "status event missing from history");
  assert.equal(statusEvent.issueId, issueId);
  assert.equal(statusEvent.kind, "status");
  assert.equal(statusEvent.actorType, "agent");
  assert.equal(statusEvent.fromStatus, "backlog");
  assert.equal(statusEvent.toStatus, "todo");
  assert.equal(statusEvent.body, null);
  assertIsoTimestamp(statusEvent.createdAt);
});

test("issue_events rejects updates with SQLSTATE 23001 and keeps the stored body", async () => {
  const issueId = await seedIssue();
  const comment = await appendEvent(testDb.db, {
    issueId,
    kind: "comment",
    actorType: "human",
    body: "original",
  });

  await assert.rejects(
    testDb.db.query("update issue_events set body = 'tampered' where id = $1", [comment.id]),
    (error: unknown) => pgErrorCode(error) === "23001",
  );

  const stored = (await listEvents(testDb.db, issueId)).find(
    (event) => event.id === comment.id,
  );
  assert.ok(stored, "comment event missing from history");
  assert.equal(stored.body, "original");
});

test("issue_events rejects deletes with SQLSTATE 23001 and keeps every event", async () => {
  const issueId = await seedIssue();
  await appendEvent(testDb.db, {
    issueId,
    kind: "comment",
    actorType: "human",
    body: "keep me",
  });

  const before = await listEvents(testDb.db, issueId);

  await assert.rejects(
    testDb.db.query("delete from issue_events"),
    (error: unknown) => pgErrorCode(error) === "23001",
  );

  const afterDelete = await listEvents(testDb.db, issueId);
  assert.equal(afterDelete.length, before.length);
  assert.deepEqual(
    afterDelete.map((event) => event.id),
    before.map((event) => event.id),
  );
});
