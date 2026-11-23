import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ServiceError, type ErrorCode } from "../src/domain/errors.ts";
import { createAgent } from "../src/application/agents.ts";
import {
  createIssue,
  getIssue,
  moveIssue,
} from "../src/application/issues.ts";
import type { Issue, IssueEvent } from "../src/domain/types.ts";
import { createProject } from "../src/application/projects.ts";
import { claimNext, listReady } from "../src/application/queue.ts";
import { addRelation, removeRelation } from "../src/application/relations.ts";
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
  await createProject(testDb.ports, { key, name: key });
}

async function seedIssue(
  project = "TAC",
  title = "Issue",
  status = "todo",
): Promise<Issue> {
  return createIssue(testDb.ports, { project, title, status, priority: 3 });
}

async function seedAgent(name: string): Promise<void> {
  await createAgent(testDb.ports, name);
}

function withKind(events: IssueEvent[], kind: IssueEvent["kind"]): IssueEvent[] {
  return events.filter((event) => event.kind === kind);
}

/** Walks a backlog issue down the legal human edges to done. */
async function markDone(key: string): Promise<void> {
  for (const to of ["todo", "in_progress", "in_review", "done"]) {
    await moveIssue(testDb.ports, { key, to });
  }
}

// --- Relation recording ---------------------------------------------------

test("addRelation records both directions and one event on the blocked issue", async () => {
  await seedProject();
  const blocker = await seedIssue("TAC", "Blocker", "backlog");
  const blocked = await seedIssue("TAC", "Blocked", "todo");

  const result = await addRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });
  assert.equal(result.key, blocked.key);
  assert.deepEqual(result.relations, {
    blocks: [],
    blockedBy: [blocker.key],
  });

  const blockerRead = await getIssue(testDb.ports, blocker.key);
  assert.deepEqual(blockerRead.relations, {
    blocks: [blocked.key],
    blockedBy: [],
  });
  const blockedRead = await getIssue(testDb.ports, blocked.key);
  assert.deepEqual(blockedRead.relations, {
    blocks: [],
    blockedBy: [blocker.key],
  });

  const blockedEvents = withKind(
    await testDb.ports.events.list(blocked.id),
    "relation",
  );
  assert.equal(blockedEvents.length, 1);
  const [event] = blockedEvents;
  assert.ok(event, "expected a relation event");
  assert.equal(event.issueId, blocked.id);
  assert.equal(event.actorType, "human");
  assert.equal(event.fromStatus, null);
  assert.equal(event.toStatus, null);
  assert.equal(
    event.body,
    JSON.stringify({ blocking: blocker.key, blocked: blocked.key }),
  );

  assert.deepEqual(
    withKind(await testDb.ports.events.list(blocker.id), "relation"),
    [],
  );
});

test("adding the same relation twice is idempotent and writes no second event", async () => {
  await seedProject();
  const blocker = await seedIssue("TAC", "Blocker", "backlog");
  const blocked = await seedIssue("TAC", "Blocked", "todo");

  const first = await addRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });
  const second = await addRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });

  assert.deepEqual(second.relations, first.relations);
  assert.deepEqual(second.relations, {
    blocks: [],
    blockedBy: [blocker.key],
  });
  assert.equal(
    withKind(await testDb.ports.events.list(blocked.id), "relation").length,
    1,
  );
});

test("addRelation validates the edge and rejects unknown issues and agent actors", async () => {
  await seedProject();
  const blocker = await seedIssue("TAC", "Blocker", "backlog");
  const blocked = await seedIssue("TAC", "Blocked", "todo");

  await assert.rejects(
    addRelation(testDb.ports, { blocked: blocker.key, blocking: blocker.key }),
    rejectsWithServiceCode("validation"),
  );
  await assert.rejects(
    addRelation(testDb.ports, { blocked: "TAC-99", blocking: blocker.key }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    addRelation(testDb.ports, { blocked: blocked.key, blocking: "TAC-99" }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    addRelation(testDb.ports, {
      blocked: blocked.key,
      blocking: blocker.key,
      actor: "agent",
      agent: "alpha",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  assert.deepEqual(
    withKind(await testDb.ports.events.list(blocked.id), "relation"),
    [],
  );
  assert.deepEqual((await getIssue(testDb.ports, blocked.key)).relations, {
    blocks: [],
    blockedBy: [],
  });
});

test("removeRelation deletes both directions and records one removal event", async () => {
  await seedProject();
  const blocker = await seedIssue("TAC", "Blocker", "backlog");
  const blocked = await seedIssue("TAC", "Blocked", "todo");

  await addRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });
  const result = await removeRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });
  assert.equal(result.key, blocked.key);
  assert.deepEqual(result.relations, { blocks: [], blockedBy: [] });
  assert.deepEqual((await getIssue(testDb.ports, blocker.key)).relations, {
    blocks: [],
    blockedBy: [],
  });

  const blockedEvents = withKind(
    await testDb.ports.events.list(blocked.id),
    "relation",
  );
  assert.equal(blockedEvents.length, 2);
  const removal = blockedEvents[1];
  assert.ok(removal, "expected a removal relation event");
  assert.equal(removal.actorType, "human");
  assert.equal(removal.fromStatus, null);
  assert.equal(removal.toStatus, null);
  assert.equal(
    removal.body,
    JSON.stringify({
      blocking: blocker.key,
      blocked: blocked.key,
      removed: true,
    }),
  );
});

test("removing an absent relation is idempotent and writes no event", async () => {
  await seedProject();
  const blocker = await seedIssue("TAC", "Blocker", "backlog");
  const blocked = await seedIssue("TAC", "Blocked", "todo");

  const first = await removeRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });
  const second = await removeRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });
  assert.deepEqual(first.relations, { blocks: [], blockedBy: [] });
  assert.deepEqual(second.relations, { blocks: [], blockedBy: [] });
  assert.equal(
    withKind(await testDb.ports.events.list(blocked.id), "relation").length,
    0,
  );
});

test("removeRelation rejects self, unknown issues, and agent actors", async () => {
  await seedProject();
  const blocker = await seedIssue("TAC", "Blocker", "backlog");
  const blocked = await seedIssue("TAC", "Blocked", "todo");

  await assert.rejects(
    removeRelation(testDb.ports, {
      blocked: blocker.key,
      blocking: blocker.key,
    }),
    rejectsWithServiceCode("validation"),
  );
  await assert.rejects(
    removeRelation(testDb.ports, { blocked: "TAC-99", blocking: blocker.key }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    removeRelation(testDb.ports, { blocked: blocked.key, blocking: "TAC-99" }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    removeRelation(testDb.ports, {
      blocked: blocked.key,
      blocking: blocker.key,
      actor: "agent",
      agent: "alpha",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );
});

// --- Ready queue gating ---------------------------------------------------

test("an open blocker keeps a todo issue out of the ready queue until it is done", async () => {
  await seedProject();
  await seedAgent("alpha");
  const blocker = await seedIssue("TAC", "Blocker", "backlog");
  const blocked = await seedIssue("TAC", "Blocked", "todo");
  await addRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });

  const gated = await listReady(testDb.ports, { project: "TAC" });
  assert.deepEqual(gated.ready.map((issue) => issue.key), []);
  await assert.rejects(
    claimNext(testDb.ports, { project: "TAC" }, "alpha"),
    rejectsWithServiceCode("no_ready_issue"),
  );
  assert.equal((await getIssue(testDb.ports, blocked.key)).status, "todo");

  await markDone(blocker.key);

  const ready = await listReady(testDb.ports, { project: "TAC" });
  assert.deepEqual(
    ready.ready.map((issue) => issue.key),
    [blocked.key],
  );
  const claimed = await claimNext(testDb.ports, { project: "TAC" }, "alpha");
  assert.equal(claimed.key, blocked.key);
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.claimedBy, "alpha");
});

test("a blocker in another project also gates the ready queue", async () => {
  await seedProject("TAC");
  await seedProject("AAA");
  await seedAgent("alpha");
  const blocker = await seedIssue("AAA", "Cross-project blocker", "backlog");
  const blocked = await seedIssue("TAC", "Cross-project blocked", "todo");
  await addRelation(testDb.ports, {
    blocked: blocked.key,
    blocking: blocker.key,
  });

  const gated = await listReady(testDb.ports, { project: "TAC" });
  assert.deepEqual(gated.ready.map((issue) => issue.key), []);
  await assert.rejects(
    claimNext(testDb.ports, { project: "TAC" }, "alpha"),
    rejectsWithServiceCode("no_ready_issue"),
  );

  await markDone(blocker.key);

  const ready = await listReady(testDb.ports, { project: "TAC" });
  assert.deepEqual(
    ready.ready.map((issue) => issue.key),
    [blocked.key],
  );
  const claimed = await claimNext(testDb.ports, { project: "TAC" }, "alpha");
  assert.equal(claimed.key, blocked.key);
  assert.equal(claimed.claimedBy, "alpha");
});
