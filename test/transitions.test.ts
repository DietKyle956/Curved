import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ServiceError, type ErrorCode } from "../src/errors.ts";
import { createAgent } from "../src/services/agents.ts";
import { listEvents, type IssueEvent } from "../src/services/events.ts";
import {
  createIssue,
  getIssue,
  getIssueTimeline,
  listIssues,
  moveIssue,
  type Issue,
} from "../src/services/issues.ts";
import { createProject } from "../src/services/projects.ts";
import type { Status } from "../src/shared/status.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

let testDb: TestDatabase;

before(async () => {
  testDb = await openTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
  await createAgent(testDb.db, "agent-1");
  await createAgent(testDb.db, "agent-2");
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

async function seedProject(key = "TAC"): Promise<void> {
  await createProject(testDb.db, { key, name: key });
}

async function seedIssue(status: Status = "todo", title = "Transition target"): Promise<Issue> {
  return createIssue(testDb.db, { project: "TAC", title, status });
}

interface MoveOptions {
  actor?: string;
  agent?: string;
  body?: string;
}

async function move(key: string, to: string, options: MoveOptions = {}): Promise<Issue> {
  return moveIssue(testDb.db, { key, to, ...options });
}

function eventAt(events: IssueEvent[], index: number): IssueEvent {
  const event = events[index];
  assert.ok(event, `expected an event at index ${index}`);
  return event;
}

async function transitionsFor(
  key: string,
  context: { actor?: string; agent?: string },
): Promise<Status[]> {
  const issue = await getIssue(testDb.db, key, context);
  return issue.allowedTransitions;
}

test("moveIssue rejects todo -> done for a human as illegal_transition and appends no event", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  await assert.rejects(
    move(issue.key, "done", { actor: "human" }),
    rejectsWithServiceCode("illegal_transition"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "todo");

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 1);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created"],
  );
});

test("a legal human move appends exactly one status event with from, to, actor, and trimmed body", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  const moved = await move(issue.key, "in_progress", {
    actor: "human",
    body: "  starting work  ",
  });

  assert.equal(moved.key, issue.key);
  assert.equal(moved.status, "in_progress");
  assert.equal(moved.claimedBy, null);

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 2);
  assert.equal(eventAt(events, 0).kind, "created");

  const statusEvent = eventAt(events, 1);
  assert.equal(statusEvent.issueId, issue.id);
  assert.equal(statusEvent.kind, "status");
  assert.equal(statusEvent.actorType, "human");
  assert.equal(statusEvent.fromStatus, "todo");
  assert.equal(statusEvent.toStatus, "in_progress");
  assert.equal(statusEvent.body, "starting work");
});

test("a human can move done -> todo and the agent claim is cleared", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  const inProgress = await move(issue.key, "in_progress", {
    actor: "agent",
    agent: "agent-1",
  });
  assert.equal(inProgress.claimedBy, "agent-1");

  const inReview = await move(issue.key, "in_review", {
    actor: "agent",
    agent: "agent-1",
  });
  assert.equal(inReview.claimedBy, "agent-1");

  const done = await move(issue.key, "done", { actor: "human" });
  assert.equal(done.status, "done");
  assert.equal(done.claimedBy, "agent-1");

  const reopened = await move(issue.key, "todo", { actor: "human" });
  assert.equal(reopened.status, "todo");
  assert.equal(reopened.claimedBy, null);

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "status", "status", "status", "status"],
  );
  assert.equal(eventAt(events, 4).fromStatus, "done");
  assert.equal(eventAt(events, 4).toStatus, "todo");
});

test("an agent cannot move its own in_review issue to done", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  await move(issue.key, "in_progress", { actor: "agent", agent: "agent-1" });
  await move(issue.key, "in_review", { actor: "agent", agent: "agent-1" });

  await assert.rejects(
    move(issue.key, "done", { actor: "agent", agent: "agent-1" }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "in_review");
  assert.equal(current.claimedBy, "agent-1");

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 3);
  assert.equal(events.at(-1)?.toStatus, "in_review");
});

test("an agent cannot move an unclaimed in_progress issue", async () => {
  await seedProject();
  const issue = await seedIssue("in_progress");

  await assert.rejects(
    move(issue.key, "in_review", { actor: "agent", agent: "agent-1" }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "in_progress");
  assert.equal(current.claimedBy, null);

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 1);
});

test("an agent cannot touch another agent's claim, while the owner can release it", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  await move(issue.key, "in_progress", { actor: "agent", agent: "agent-1" });

  await assert.rejects(
    move(issue.key, "todo", { actor: "agent", agent: "agent-2" }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const held = await getIssue(testDb.db, issue.key);
  assert.equal(held.status, "in_progress");
  assert.equal(held.claimedBy, "agent-1");

  const released = await move(issue.key, "todo", { actor: "agent", agent: "agent-1" });
  assert.equal(released.status, "todo");
  assert.equal(released.claimedBy, null);

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "status", "status"],
  );
});

test("claim ownership follows target status: set on agent claim, kept on in_review and done, cleared on todo and backlog", async () => {
  await seedProject();

  const claimed = await seedIssue("todo", "Claimed chain");
  const started = await move(claimed.key, "in_progress", {
    actor: "agent",
    agent: "agent-1",
  });
  assert.equal(started.claimedBy, "agent-1");

  const review = await move(claimed.key, "in_review", {
    actor: "agent",
    agent: "agent-1",
  });
  assert.equal(review.claimedBy, "agent-1");

  const done = await move(claimed.key, "done", { actor: "human" });
  assert.equal(done.claimedBy, "agent-1");

  const reopened = await move(claimed.key, "todo", { actor: "human" });
  assert.equal(reopened.claimedBy, null);

  const humanStart = await seedIssue("todo", "Human start");
  const humanInProgress = await move(humanStart.key, "in_progress", { actor: "human" });
  assert.equal(humanInProgress.claimedBy, null);

  const triaged = await seedIssue("todo", "Back to backlog");
  const backlog = await move(triaged.key, "backlog", { actor: "human" });
  assert.equal(backlog.status, "backlog");
  assert.equal(backlog.claimedBy, null);
});

test("the git actor can move in_progress -> in_review and in_review -> done but cannot claim", async () => {
  await seedProject();

  const inProgress = await seedIssue("in_progress", "Git review");
  const inReview = await move(inProgress.key, "in_review", { actor: "git" });
  assert.equal(inReview.status, "in_review");

  const done = await move(inProgress.key, "done", { actor: "git" });
  assert.equal(done.status, "done");

  const events = await listEvents(testDb.db, inProgress.id);
  assert.equal(events.length, 3);
  assert.equal(eventAt(events, 1).actorType, "git");
  assert.equal(eventAt(events, 1).fromStatus, "in_progress");
  assert.equal(eventAt(events, 1).toStatus, "in_review");
  assert.equal(eventAt(events, 2).actorType, "git");
  assert.equal(eventAt(events, 2).fromStatus, "in_review");
  assert.equal(eventAt(events, 2).toStatus, "done");

  const todo = await seedIssue("todo", "Git claim");
  await assert.rejects(
    move(todo.key, "in_progress", { actor: "git" }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const current = await getIssue(testDb.db, todo.key);
  assert.equal(current.status, "todo");
  assert.equal(current.claimedBy, null);

  const todoEvents = await listEvents(testDb.db, todo.id);
  assert.equal(todoEvents.length, 1);
});

test("the system actor is rejected with forbidden_transition even on a legal edge", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  await assert.rejects(
    move(issue.key, "backlog", { actor: "system" }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  await assert.rejects(
    move(issue.key, "in_progress", { actor: "system" }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "todo");

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 1);
});

test("allowedTransitions reflects the actor, the claim, and the current status across every read", async () => {
  await seedProject();

  const backlog = await createIssue(testDb.db, { project: "TAC", title: "Backlog" });
  assert.deepEqual(backlog.allowedTransitions, ["todo"]);

  const todo = await createIssue(testDb.db, {
    project: "TAC",
    title: "Todo",
    status: "todo",
  });
  assert.deepEqual(todo.allowedTransitions, ["backlog", "in_progress"]);

  const unclaimedTodo = await seedIssue("todo", "Unclaimed todo");
  assert.deepEqual(await transitionsFor(unclaimedTodo.key, { actor: "agent", agent: "agent-1" }), [
    "in_progress",
  ]);
  assert.deepEqual(await transitionsFor(unclaimedTodo.key, { actor: "agent", agent: "agent-2" }), [
    "in_progress",
  ]);

  const claimed = await seedIssue("todo", "Claimed");
  await move(claimed.key, "in_progress", { actor: "agent", agent: "agent-1" });
  assert.deepEqual(await transitionsFor(claimed.key, { actor: "agent", agent: "agent-1" }), [
    "todo",
    "in_review",
  ]);
  assert.deepEqual(await transitionsFor(claimed.key, { actor: "agent", agent: "agent-2" }), []);
  assert.deepEqual(await transitionsFor(claimed.key, { actor: "human" }), [
    "todo",
    "in_review",
  ]);

  const ownedReview = await seedIssue("todo", "Owned review");
  await move(ownedReview.key, "in_progress", { actor: "agent", agent: "agent-2" });
  await move(ownedReview.key, "in_review", { actor: "agent", agent: "agent-2" });
  assert.deepEqual(await transitionsFor(ownedReview.key, { actor: "agent", agent: "agent-1" }), []);
  assert.deepEqual(await transitionsFor(ownedReview.key, { actor: "agent", agent: "agent-2" }), []);
  assert.deepEqual(await transitionsFor(ownedReview.key, { actor: "human" }), [
    "done",
    "in_progress",
  ]);

  const gitTodo = await seedIssue("todo", "Git todo");
  assert.deepEqual(await transitionsFor(gitTodo.key, { actor: "git" }), []);

  const gitInProgress = await seedIssue("in_progress", "Git in progress");
  assert.deepEqual(await transitionsFor(gitInProgress.key, { actor: "git" }), ["in_review"]);
  await move(gitInProgress.key, "in_review", { actor: "git" });
  assert.deepEqual(await transitionsFor(gitInProgress.key, { actor: "git" }), ["done"]);

  const agentList = await listIssues(
    testDb.db,
    { project: "TAC" },
    { actor: "agent", agent: "agent-1" },
  );
  const byKey = new Map(agentList.map((issue) => [issue.key, issue.allowedTransitions]));
  assert.deepEqual(byKey.get(backlog.key), []);
  assert.deepEqual(byKey.get(todo.key), ["in_progress"]);
  assert.deepEqual(byKey.get(unclaimedTodo.key), ["in_progress"]);
  assert.deepEqual(byKey.get(claimed.key), ["todo", "in_review"]);
  assert.deepEqual(byKey.get(ownedReview.key), []);
  assert.deepEqual(byKey.get(gitTodo.key), ["in_progress"]);
  assert.deepEqual(byKey.get(gitInProgress.key), []);

  const humanList = await listIssues(testDb.db, { project: "TAC" }, { actor: "human" });
  const humanByKey = new Map(humanList.map((issue) => [issue.key, issue.allowedTransitions]));
  assert.deepEqual(humanByKey.get(backlog.key), ["todo"]);
  assert.deepEqual(humanByKey.get(todo.key), ["backlog", "in_progress"]);
  assert.deepEqual(humanByKey.get(gitInProgress.key), ["done", "in_progress"]);

  const backlogTimeline = await getIssueTimeline(testDb.db, backlog.key);
  assert.deepEqual(backlogTimeline.issue.allowedTransitions, ["todo"]);

  const claimedTimeline = await getIssueTimeline(testDb.db, claimed.key, {
    actor: "agent",
    agent: "agent-1",
  });
  assert.deepEqual(claimedTimeline.issue.allowedTransitions, ["todo", "in_review"]);
});

test("concurrent human moves of one todo issue settle one success and one illegal_transition", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  const results = await Promise.allSettled([
    move(issue.key, "in_progress", { actor: "human" }),
    move(issue.key, "in_progress", { actor: "human" }),
  ]);

  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<Issue> => result.status === "fulfilled",
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const [winner] = fulfilled;
  assert.ok(winner, "expected one fulfilled move");
  assert.equal(winner.value.status, "in_progress");

  const [loser] = rejected;
  assert.ok(loser, "expected one rejected move");
  assert.ok(loser.reason instanceof ServiceError);
  assert.equal(loser.reason.code, "illegal_transition");

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "in_progress");
  assert.equal(current.claimedBy, null);

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "status"],
  );
  assert.equal(eventAt(events, 1).fromStatus, "todo");
  assert.equal(eventAt(events, 1).toStatus, "in_progress");
});

test("moveIssue rejects unknown keys, statuses, actors, and mismatched agent identities with validation errors", async () => {
  await seedProject();
  const issue = await seedIssue("todo");

  await assert.rejects(
    move("TAC-99", "in_progress", { actor: "human" }),
    rejectsWithServiceCode("not_found"),
  );

  await assert.rejects(
    move(issue.key, "nope", { actor: "human" }),
    rejectsWithServiceCode("validation"),
  );

  await assert.rejects(
    move(issue.key, "in_progress", { actor: "robot" }),
    rejectsWithServiceCode("validation"),
  );

  await assert.rejects(
    move(issue.key, "in_progress", { actor: "agent" }),
    rejectsWithServiceCode("validation"),
  );

  await assert.rejects(
    move(issue.key, "in_progress", { actor: "human", agent: "agent-1" }),
    rejectsWithServiceCode("validation"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "todo");

  const events = await listEvents(testDb.db, issue.id);
  assert.equal(events.length, 1);
});
