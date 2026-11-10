import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Db } from "../src/db.ts";
import { ServiceError, type ErrorCode } from "../src/errors.ts";
import { listEvents, type IssueEvent } from "../src/services/events.ts";
import {
  createIssue,
  getIssue,
  getIssueTimeline,
  listIssues,
  type Issue,
} from "../src/services/issues.ts";
import { setIssueLabels } from "../src/services/labels.ts";
import { createProject } from "../src/services/projects.ts";
import { addRelation } from "../src/services/relations.ts";
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

async function seedIssue(
  project = "TAC",
  title = "Issue",
): Promise<Issue> {
  return createIssue(testDb.db, {
    project,
    title,
    status: "todo",
    priority: 3,
  });
}

function withKind(events: IssueEvent[], kind: IssueEvent["kind"]): IssueEvent[] {
  return events.filter((event) => event.kind === kind);
}

/**
 * Wraps a `Db` and records every SQL string that crosses it, so a test can
 * pin the statement budget of a read path.
 */
function countingDb(db: Db): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const counted = {
    async query(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      return db.query(sql, params);
    },
    async one(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      return db.one(sql, params);
    },
  } as unknown as Db;
  return { db: counted, statements };
}

// --- Replacement ----------------------------------------------------------

test("setIssueLabels replaces the label set and returns names ascending", async () => {
  await seedProject();
  const issue = await seedIssue();

  const first = await setIssueLabels(testDb.db, {
    key: issue.key,
    labels: ["beta", "alpha"],
  });
  assert.deepEqual(first.labels, ["alpha", "beta"]);

  const second = await setIssueLabels(testDb.db, {
    key: issue.key,
    labels: ["gamma", "beta"],
  });
  assert.deepEqual(second.labels, ["beta", "gamma"]);

  const reloaded = await getIssue(testDb.db, issue.key);
  assert.deepEqual(reloaded.labels, ["beta", "gamma"]);

  const rows = await testDb.db.query<{ name: string }>(
    `select l.name
     from issue_labels il
     join labels l on l.id = il.label_id
     where il.issue_id = $1
     order by l.name asc`,
    [issue.id],
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ["beta", "gamma"],
  );
});

test("setIssueLabels trims names and collapses duplicates in one call", async () => {
  await seedProject();
  const issue = await seedIssue();

  const updated = await setIssueLabels(testDb.db, {
    key: issue.key,
    labels: ["  ui  ", "bug", "ui", " bug "],
  });
  assert.deepEqual(updated.labels, ["bug", "ui"]);

  const events = withKind(await listEvents(testDb.db, issue.id), "labels");
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event, "expected a labels event");
  assert.equal(event.body, JSON.stringify({ labels: ["bug", "ui"] }));
});

test("labels are upserted per project and reused across projects", async () => {
  await seedProject("TAC");
  await seedProject("AAA");
  const first = await seedIssue("TAC", "First");
  const second = await seedIssue("TAC", "Second");
  const other = await seedIssue("AAA", "Other");

  await setIssueLabels(testDb.db, { key: first.key, labels: ["ui"] });
  await setIssueLabels(testDb.db, { key: second.key, labels: ["ui"] });
  await setIssueLabels(testDb.db, { key: other.key, labels: ["ui"] });

  const labelRows = await testDb.db.query<{ project_id: number; name: string }>(
    `select project_id, name from labels where name = $1 order by project_id asc`,
    ["ui"],
  );
  assert.equal(labelRows.length, 2);

  const linkRows = await testDb.db.query<{ count: number }>(
    `select count(*)::int as count
     from issue_labels il
     join labels l on l.id = il.label_id
     where l.name = $1`,
    ["ui"],
  );
  assert.equal(linkRows[0]?.count, 3);

  assert.deepEqual((await getIssue(testDb.db, first.key)).labels, ["ui"]);
  assert.deepEqual((await getIssue(testDb.db, other.key)).labels, ["ui"]);
});

// --- Events ---------------------------------------------------------------

test("each label replacement appends one labels event with a JSON body", async () => {
  await seedProject();
  const issue = await seedIssue();

  await setIssueLabels(testDb.db, {
    key: issue.key,
    labels: ["beta", "alpha"],
  });
  await setIssueLabels(testDb.db, { key: issue.key, labels: ["gamma"] });

  const events = withKind(await listEvents(testDb.db, issue.id), "labels");
  assert.equal(events.length, 2);
  const [firstEvent, secondEvent] = events;
  assert.ok(firstEvent, "expected a first labels event");
  assert.ok(secondEvent, "expected a second labels event");
  assert.equal(firstEvent.issueId, issue.id);
  assert.equal(firstEvent.actorType, "human");
  assert.equal(firstEvent.fromStatus, null);
  assert.equal(firstEvent.toStatus, null);
  assert.equal(firstEvent.body, JSON.stringify({ labels: ["alpha", "beta"] }));
  assert.equal(secondEvent.body, JSON.stringify({ labels: ["gamma"] }));
});

test("an empty label array clears the set and still appends one event", async () => {
  await seedProject();
  const issue = await seedIssue();
  await setIssueLabels(testDb.db, { key: issue.key, labels: ["alpha", "beta"] });

  const cleared = await setIssueLabels(testDb.db, {
    key: issue.key,
    labels: [],
  });
  assert.deepEqual(cleared.labels, []);
  assert.deepEqual((await getIssue(testDb.db, issue.key)).labels, []);

  const events = withKind(await listEvents(testDb.db, issue.id), "labels");
  assert.equal(events.length, 2);
  const [firstEvent, secondEvent] = events;
  assert.ok(firstEvent, "expected the first labels event");
  assert.ok(secondEvent, "expected the clearing labels event");
  assert.equal(firstEvent.body, JSON.stringify({ labels: ["alpha", "beta"] }));
  assert.equal(secondEvent.body, JSON.stringify({ labels: [] }));
  assert.equal(secondEvent.actorType, "human");
  assert.equal(secondEvent.fromStatus, null);
  assert.equal(secondEvent.toStatus, null);
});

// --- Validation and authorization ----------------------------------------

test("setIssueLabels validates names and rejects non-arrays", async () => {
  await seedProject();
  const issue = await seedIssue();

  const cases: Array<[string, unknown]> = [
    ["non-array", "ui"],
    ["blank name", ["   "]],
    ["empty name", [""]],
    ["non-string member", ["ui", 42]],
    ["51-character name", ["x".repeat(51)]],
  ];
  for (const [label, labels] of cases) {
    await assert.rejects(
      setIssueLabels(testDb.db, {
        key: issue.key,
        labels: labels as string[],
      }),
      rejectsWithServiceCode("validation"),
      label,
    );
  }

  const maximum = await setIssueLabels(testDb.db, {
    key: issue.key,
    labels: ["x".repeat(50)],
  });
  assert.deepEqual(maximum.labels, ["x".repeat(50)]);
});

test("setIssueLabels rejects an unknown issue and an agent actor", async () => {
  await seedProject();
  const issue = await seedIssue();

  await assert.rejects(
    setIssueLabels(testDb.db, { key: "TAC-99", labels: ["ui"] }),
    rejectsWithServiceCode("not_found"),
  );
  await assert.rejects(
    setIssueLabels(testDb.db, {
      key: issue.key,
      labels: ["ui"],
      actor: "agent",
      agent: "alpha",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  assert.deepEqual((await getIssue(testDb.db, issue.key)).labels, []);
  assert.deepEqual(
    withKind(await listEvents(testDb.db, issue.id), "labels"),
    [],
  );
});

// --- Payload surfaces -----------------------------------------------------

test("getIssue, listIssues, and the timeline expose labels", async () => {
  await seedProject();
  const labelled = await seedIssue("TAC", "Labelled");
  await seedIssue("TAC", "Plain");
  await setIssueLabels(testDb.db, {
    key: labelled.key,
    labels: ["ui", "bug"],
  });

  const read = await getIssue(testDb.db, labelled.key);
  assert.deepEqual(read.labels, ["bug", "ui"]);

  const listed = await listIssues(testDb.db, { project: "TAC" });
  assert.deepEqual(
    listed.map((issue) => issue.labels),
    [["bug", "ui"], []],
  );

  const timeline = await getIssueTimeline(testDb.db, labelled.key);
  assert.deepEqual(timeline.issue.labels, ["bug", "ui"]);
});

// --- Query budget ---------------------------------------------------------

test("listIssues loads a whole project in three statements", async () => {
  await seedProject("TAC");
  const first = await seedIssue("TAC", "First");
  await seedIssue("TAC", "Second");
  const third = await seedIssue("TAC", "Third");
  await setIssueLabels(testDb.db, { key: first.key, labels: ["ui"] });
  await addRelation(testDb.db, { blocked: third.key, blocking: first.key });

  const { db, statements } = countingDb(testDb.db);
  const issues = await listIssues(db, { project: "TAC" });

  assert.equal(statements.length, 3);
  assert.equal(
    statements.filter((sql) => sql.includes("issue_labels")).length,
    1,
  );
  assert.equal(
    statements.filter((sql) => sql.includes("issue_relations")).length,
    1,
  );

  assert.equal(issues.length, 3);
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  assert.deepEqual(byKey.get(first.key)?.labels, ["ui"]);
  assert.deepEqual(byKey.get(first.key)?.relations, {
    blocks: [third.key],
    blockedBy: [],
  });
  assert.deepEqual(byKey.get(third.key)?.labels, []);
  assert.deepEqual(byKey.get(third.key)?.relations, {
    blocks: [],
    blockedBy: [first.key],
  });
});
