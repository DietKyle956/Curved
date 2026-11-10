import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ServiceError, type ErrorCode } from "../src/errors.ts";
import { createAgent } from "../src/services/agents.ts";
import {
  BLOCKED_REASON_MAX_LENGTH,
  blockIssue,
  unblockIssue,
} from "../src/services/blocking.ts";
import { listEvents, type IssueEvent } from "../src/services/events.ts";
import {
  createIssue,
  getIssue,
  listIssues,
  type Issue,
} from "../src/services/issues.ts";
import { createProject } from "../src/services/projects.ts";
import {
  claimNext,
  listReady,
  submitForReview,
} from "../src/services/queue.ts";
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
    assert.ok(
      error instanceof ServiceError,
      `expected ServiceError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  };
}

async function seedProject(key = "TAC"): Promise<void> {
  await createProject(testDb.db, { key, name: key });
}

async function seedIssue(title = "Queue issue"): Promise<Issue> {
  return createIssue(testDb.db, {
    project: "TAC",
    title,
    status: "todo",
    priority: 3,
  });
}

async function seedAgent(name: string): Promise<void> {
  await createAgent(testDb.db, name);
}

function withKind(events: IssueEvent[], kind: IssueEvent["kind"]): IssueEvent[] {
  return events.filter((event) => event.kind === kind);
}

async function seedClaimedIssue(agent: string): Promise<Issue> {
  const issue = await seedIssue();
  await claimNext(testDb.db, {}, agent);
  return issue;
}

// --- Blocking -------------------------------------------------------------

test("blockIssue trims the reason, returns the issue to todo, and appends one blocked event", async () => {
  await seedProject();
  await seedAgent("alpha");
  const issue = await seedClaimedIssue("alpha");

  const blocked = await blockIssue(testDb.db, {
    key: issue.key,
    agent: "alpha",
    reason: "  needs design review\t",
  });

  assert.equal(blocked.key, issue.key);
  assert.equal(blocked.status, "todo");
  assert.equal(blocked.claimedBy, null);
  assert.equal(blocked.blockedReason, "needs design review");

  const events = await listEvents(testDb.db, issue.id);
  const blockedEvents = withKind(events, "blocked");
  assert.equal(blockedEvents.length, 1);
  const event = blockedEvents[0];
  assert.ok(event, "expected a blocked event");
  assert.equal(event.issueId, issue.id);
  assert.equal(event.actorType, "agent");
  assert.equal(event.fromStatus, "in_progress");
  assert.equal(event.toStatus, "todo");
  assert.equal(event.body, "needs design review");
});

test("a blocked issue leaves the ready queue until it is unblocked, then is claimable again", async () => {
  await seedProject();
  await seedAgent("alpha");
  const issue = await seedClaimedIssue("alpha");

  await blockIssue(testDb.db, {
    key: issue.key,
    agent: "alpha",
    reason: "waiting on vendor",
  });

  const blockedQueue = await listReady(testDb.db, { project: "TAC" });
  assert.deepEqual(
    blockedQueue.ready.map((ready) => ready.key),
    [],
  );
  await assert.rejects(
    claimNext(testDb.db, { project: "TAC" }, "alpha"),
    rejectsWithServiceCode("no_ready_issue"),
  );

  const unblocked = await unblockIssue(testDb.db, { key: issue.key });
  assert.equal(unblocked.key, issue.key);
  assert.equal(unblocked.blockedReason, null);

  const readyQueue = await listReady(testDb.db, { project: "TAC" });
  assert.deepEqual(
    readyQueue.ready.map((ready) => ready.key),
    [issue.key],
  );

  const reclaimed = await claimNext(testDb.db, { project: "TAC" }, "alpha");
  assert.equal(reclaimed.key, issue.key);
  assert.equal(reclaimed.status, "in_progress");
  assert.equal(reclaimed.claimedBy, "alpha");
});

test("getIssue and listIssues expose blockedReason, and unblocking appends unblocked after blocked", async () => {
  await seedProject();
  await seedAgent("alpha");
  const issue = await seedClaimedIssue("alpha");

  await blockIssue(testDb.db, {
    key: issue.key,
    agent: "alpha",
    reason: "blocked on review",
  });

  const read = await getIssue(testDb.db, issue.key);
  assert.equal(read.blockedReason, "blocked on review");
  assert.equal(read.status, "todo");

  const listed = await listIssues(testDb.db);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.key, issue.key);
  assert.equal(listed[0]?.blockedReason, "blocked on review");

  await unblockIssue(testDb.db, { key: issue.key });

  const afterUnblock = await getIssue(testDb.db, issue.key);
  assert.equal(afterUnblock.blockedReason, null);
  const listedAfterUnblock = await listIssues(testDb.db);
  assert.equal(listedAfterUnblock[0]?.blockedReason, null);

  const events = await listEvents(testDb.db, issue.id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "claim", "blocked", "unblocked"],
  );
  const blockedEvent = withKind(events, "blocked")[0];
  const unblockedEvent = withKind(events, "unblocked")[0];
  assert.ok(blockedEvent, "expected a blocked event");
  assert.ok(unblockedEvent, "expected an unblocked event");
  assert.ok(unblockedEvent.id > blockedEvent.id);
  assert.equal(unblockedEvent.actorType, "human");
  assert.equal(unblockedEvent.fromStatus, null);
  assert.equal(unblockedEvent.toStatus, null);
  assert.equal(unblockedEvent.body, null);
});

test("blockIssue validates the reason length while allowing the maximum", async () => {
  await seedProject();
  await seedAgent("alpha");
  const issue = await seedClaimedIssue("alpha");

  for (const reason of ["", "   ", "\t\n"]) {
    await assert.rejects(
      blockIssue(testDb.db, { key: issue.key, agent: "alpha", reason }),
      rejectsWithServiceCode("validation"),
      JSON.stringify(reason),
    );
  }

  await assert.rejects(
    blockIssue(testDb.db, {
      key: issue.key,
      agent: "alpha",
      reason: "a".repeat(BLOCKED_REASON_MAX_LENGTH + 1),
    }),
    rejectsWithServiceCode("validation"),
  );

  const maximum = "b".repeat(BLOCKED_REASON_MAX_LENGTH);
  const blocked = await blockIssue(testDb.db, {
    key: issue.key,
    agent: "alpha",
    reason: maximum,
  });
  assert.equal(blocked.blockedReason, maximum);
  assert.equal(blocked.status, "todo");
});

test("an owning agent cannot block an issue in in_review", async () => {
  await seedProject();
  await seedAgent("alpha");
  const issue = await seedClaimedIssue("alpha");
  await submitForReview(testDb.db, {
    key: issue.key,
    agent: "alpha",
    summary: "ready for review",
  });

  await assert.rejects(
    blockIssue(testDb.db, {
      key: issue.key,
      agent: "alpha",
      reason: "needs another look",
    }),
    rejectsWithServiceCode("illegal_transition"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "in_review");
  assert.equal(current.blockedReason, null);
});

test("blockIssue requires the claiming agent on an in_progress issue", async () => {
  await seedProject();
  await seedAgent("alpha");
  await seedAgent("beta");
  const owned = await seedClaimedIssue("alpha");

  await assert.rejects(
    blockIssue(testDb.db, {
      key: owned.key,
      agent: "beta",
      reason: "not mine",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const unclaimed = await seedIssue("Unclaimed backlog item");
  await assert.rejects(
    blockIssue(testDb.db, {
      key: unclaimed.key,
      agent: "beta",
      reason: "not claimed",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const unchanged = await getIssue(testDb.db, owned.key);
  assert.equal(unchanged.status, "in_progress");
  assert.equal(unchanged.claimedBy, "alpha");
  assert.equal(unchanged.blockedReason, null);
});

test("unblockIssue rejects an agent actor and rejects an unblocked issue", async () => {
  await seedProject();
  await seedAgent("alpha");
  const issue = await seedClaimedIssue("alpha");
  await blockIssue(testDb.db, {
    key: issue.key,
    agent: "alpha",
    reason: "waiting on input",
  });

  await assert.rejects(
    unblockIssue(testDb.db, {
      key: issue.key,
      actor: "agent",
      agent: "alpha",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  const stillBlocked = await getIssue(testDb.db, issue.key);
  assert.equal(stillBlocked.blockedReason, "waiting on input");

  const neverBlocked = await seedIssue("Never blocked");
  await assert.rejects(
    unblockIssue(testDb.db, { key: neverBlocked.key }),
    rejectsWithServiceCode("validation"),
  );
});

test("a blocked issue keeps the trimmed reason in its event and stays an unclaimed todo", async () => {
  await seedProject();
  await seedAgent("alpha");
  const issue = await seedClaimedIssue("alpha");

  await blockIssue(testDb.db, {
    key: issue.key,
    agent: "alpha",
    reason: "\n\twaiting on security sign-off \n",
  });

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "todo");
  assert.equal(current.claimedBy, null);
  assert.equal(current.blockedReason, "waiting on security sign-off");

  const blockedEvents = withKind(
    await listEvents(testDb.db, issue.id),
    "blocked",
  );
  assert.equal(blockedEvents.length, 1);
  assert.equal(blockedEvents[0]?.body, "waiting on security sign-off");
});
