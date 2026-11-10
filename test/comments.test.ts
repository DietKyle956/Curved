import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { pgErrorCode } from "../src/db.ts";
import { ServiceError, type ErrorCode } from "../src/errors.ts";
import { commentOnIssue } from "../src/services/comments.ts";
import { listEvents } from "../src/services/events.ts";
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

async function seedIssue(): Promise<number> {
  await createProject(testDb.db, { key: "TAC", name: "Tactics" });
  const issue = await createIssue(testDb.db, { project: "TAC", title: "Comment target" });
  return issue.id;
}

test("commentOnIssue appends interleaved agent and human comments in insertion order", async () => {
  const issueId = await seedIssue();

  const human = await commentOnIssue(testDb.db, {
    key: "TAC-1",
    body: "  first from human  ",
  });
  const agent = await commentOnIssue(testDb.db, {
    key: "TAC-1",
    body: "second from agent",
    actor: "agent",
  });
  const humanAgain = await commentOnIssue(testDb.db, {
    key: "TAC-0001",
    body: "third from human",
    actor: "human",
  });

  assert.equal(human.kind, "comment");
  assert.equal(human.actorType, "human");
  assert.equal(human.body, "first from human");
  assert.equal(human.fromStatus, null);
  assert.equal(human.toStatus, null);
  assertIsoTimestamp(human.createdAt);

  assert.equal(agent.kind, "comment");
  assert.equal(agent.actorType, "agent");
  assert.equal(agent.body, "second from agent");
  assert.equal(agent.fromStatus, null);
  assert.equal(agent.toStatus, null);
  assertIsoTimestamp(agent.createdAt);

  assert.equal(humanAgain.actorType, "human");
  assert.equal(humanAgain.body, "third from human");

  const events = await listEvents(testDb.db, issueId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "comment", "comment", "comment"],
  );

  const ids = events.map((event) => event.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(human.id < agent.id);
  assert.ok(agent.id < humanAgain.id);
  assert.deepEqual(
    events.slice(1).map((event) => [event.actorType, event.body]),
    [
      ["human", "first from human"],
      ["agent", "second from agent"],
      ["human", "third from human"],
    ],
  );
  for (const event of events) {
    assert.equal(event.issueId, issueId);
  }
});

test("commentOnIssue rejects empty and whitespace-only bodies without appending events", async () => {
  const issueId = await seedIssue();

  for (const body of ["", "   ", "\t\n "]) {
    await assert.rejects(
      commentOnIssue(testDb.db, { key: "TAC-1", body }),
      rejectsWithServiceCode("validation"),
      JSON.stringify(body),
    );
  }

  const events = await listEvents(testDb.db, issueId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created"],
  );
});

test("commentOnIssue rejects an unknown key, a malformed key, and an invalid actor", async () => {
  const issueId = await seedIssue();

  await assert.rejects(
    commentOnIssue(testDb.db, { key: "TAC-99", body: "missing issue" }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    commentOnIssue(testDb.db, { key: "tac-1", body: "malformed key" }),
    rejectsWithServiceCode("validation"),
  );
  await assert.rejects(
    commentOnIssue(testDb.db, { key: "TAC-1", body: "wrong actor", actor: "robot" }),
    rejectsWithServiceCode("validation"),
  );

  const events = await listEvents(testDb.db, issueId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created"],
  );
});

test("issue_events rejects updates and deletes on a comment row and keeps the stored comment", async () => {
  const issueId = await seedIssue();
  const comment = await commentOnIssue(testDb.db, {
    key: "TAC-1",
    body: "original comment",
    actor: "agent",
  });

  await assert.rejects(
    testDb.db.query("update issue_events set body = 'tampered' where id = $1", [comment.id]),
    (error: unknown) => pgErrorCode(error) === "23001",
  );

  const afterUpdate = (await listEvents(testDb.db, issueId)).find(
    (event) => event.id === comment.id,
  );
  assert.ok(afterUpdate, "comment event missing after rejected update");
  assert.equal(afterUpdate.body, "original comment");
  assert.equal(afterUpdate.actorType, "agent");

  const beforeDelete = await listEvents(testDb.db, issueId);

  await assert.rejects(
    testDb.db.query("delete from issue_events"),
    (error: unknown) => pgErrorCode(error) === "23001",
  );

  const afterDelete = await listEvents(testDb.db, issueId);
  assert.deepEqual(
    afterDelete.map((event) => event.id),
    beforeDelete.map((event) => event.id),
  );
  const survived = afterDelete.find((event) => event.id === comment.id);
  assert.ok(survived, "comment event missing after rejected delete");
  assert.equal(survived.body, "original comment");
});

test("there is no separate comments table", async () => {
  const row = await testDb.db.one<{ comments: string | null }>(
    "select to_regclass('public.comments') as comments",
  );
  assert.ok(row, "to_regclass query returned no row");
  assert.equal(row.comments, null);
});
