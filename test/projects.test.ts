import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ServiceError, type ErrorCode } from "../src/domain/errors.ts";
import { createIssue, moveIssue } from "../src/application/issues.ts";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  type UpdateProjectInput,
} from "../src/application/projects.ts";
import { emptyProgress } from "../src/domain/types.ts";
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

test("createProject returns the new project with nextNumber 1 and an ISO timestamp", async () => {
  const project = await createProject(testDb.ports, { key: "TAC", name: "Tactics" });

  assert.equal(project.key, "TAC");
  assert.equal(project.name, "Tactics");
  assert.equal(project.nextNumber, 1);

  const createdAt = project.createdAt;
  assert.equal(new Date(createdAt).toISOString(), createdAt);
});

test("listProjects returns projects ordered by key", async () => {
  await createProject(testDb.ports, { key: "ZZZ", name: "Last" });
  await createProject(testDb.ports, { key: "AAA", name: "First" });
  await createProject(testDb.ports, { key: "MMM", name: "Middle" });

  const projects = await listProjects(testDb.ports);

  assert.deepEqual(
    projects.map((project) => project.key),
    ["AAA", "MMM", "ZZZ"],
  );
  assert.deepEqual(
    projects.map((project) => project.name),
    ["First", "Middle", "Last"],
  );
});

test("createProject rejects a duplicate key with a duplicate ServiceError", async () => {
  await createProject(testDb.ports, { key: "DUP", name: "Original" });

  await assert.rejects(
    createProject(testDb.ports, { key: "DUP", name: "Copy" }),
    rejectsWithServiceCode("duplicate"),
  );

  const projects = await listProjects(testDb.ports);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "Original");
});

test("createProject rejects an invalid key with a validation ServiceError", async () => {
  for (const key of ["tac", "TAC-1", "", "A B"]) {
    await assert.rejects(
      createProject(testDb.ports, { key, name: "Invalid" }),
      rejectsWithServiceCode("validation"),
      `expected key ${JSON.stringify(key)} to be rejected`,
    );
  }
});

test("createProject rejects a blank name with a validation ServiceError", async () => {
  for (const name of ["", "   "]) {
    await assert.rejects(
      createProject(testDb.ports, { key: "BLK", name }),
      rejectsWithServiceCode("validation"),
      `expected name ${JSON.stringify(name)} to be rejected`,
    );
  }
});

test("a failing transaction rolls back its inserted project", async () => {
  await assert.rejects(
    testDb.ports.transaction(async (txPorts) => {
      await createProject(txPorts, { key: "ROLL", name: "Rollback" });
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.deepEqual(await listProjects(testDb.ports), []);
});

test("a committed transaction makes its project visible", async () => {
  await testDb.ports.transaction(async (txPorts) => {
    await createProject(txPorts, { key: "CMT", name: "Committed" });
  });

  const projects = await listProjects(testDb.ports);
  assert.ok(
    projects.some((project) => project.key === "CMT"),
    "expected committed project to be visible",
  );
});

test("the project repository port resolves projects by key", async () => {
  await createProject(testDb.ports, { key: "TAC", name: "Tactics" });

  const found = await testDb.ports.projects.findByKey("TAC");
  assert.equal(found?.key, "TAC");
  assert.equal(await testDb.ports.projects.findByKey("NOPE"), null);
});

test("createProject defaults status to planned, empty fields, and empty progress", async () => {
  const project = await createProject(testDb.ports, { key: "DEF", name: "Defaults" });

  assert.equal(project.status, "planned");
  assert.equal(project.summary, "");
  assert.equal(project.description, "");
  assert.equal(project.priority, null);
  assert.equal(project.startDate, null);
  assert.equal(project.targetDate, null);
  assert.equal(project.archivedAt, null);
  assert.deepEqual(project.progress, emptyProgress());

  const createdAt = project.createdAt;
  const updatedAt = project.updatedAt;
  assert.equal(new Date(createdAt).toISOString(), createdAt);
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
});

test("createProject persists every supplied field", async () => {
  await createProject(testDb.ports, {
    key: "FULL",
    name: "Full project",
    summary: "  Ship the tactics rewrite  ",
    description: "First line.\nSecond line.",
    status: "paused",
    priority: 2,
    startDate: "2026-01-15",
    targetDate: "2026-03-01",
  });

  const project = await getProject(testDb.ports, "FULL");

  assert.equal(project.name, "Full project");
  assert.equal(project.summary, "Ship the tactics rewrite");
  assert.equal(project.description, "First line.\nSecond line.");
  assert.equal(project.status, "paused");
  assert.equal(project.priority, 2);
  assert.equal(project.startDate, "2026-01-15");
  assert.equal(project.targetDate, "2026-03-01");
  assert.equal(project.archivedAt, null);
  assert.deepEqual(project.progress, emptyProgress());
});

test("listProjects excludes archived projects unless includeArchived is true", async () => {
  await createProject(testDb.ports, { key: "ZZZ", name: "Last" });
  await createProject(testDb.ports, { key: "AAA", name: "First" });
  await createProject(testDb.ports, { key: "MMM", name: "Middle" });

  const archived = await updateProject(testDb.ports, { key: "MMM", archived: true });
  const archivedAt = archived.archivedAt;
  assert.ok(archivedAt !== null);
  assert.equal(new Date(archivedAt).toISOString(), archivedAt);

  const active = await listProjects(testDb.ports);
  assert.deepEqual(
    active.map((project) => project.key),
    ["AAA", "ZZZ"],
  );

  const all = await listProjects(testDb.ports, { includeArchived: true });
  assert.deepEqual(
    all.map((project) => project.key),
    ["AAA", "MMM", "ZZZ"],
  );
});

test("updateProject changes only the supplied fields", async () => {
  await createProject(testDb.ports, {
    key: "TAC",
    name: "Tactics",
    summary: "Original summary",
    description: "Original description",
    status: "planned",
    priority: 2,
    startDate: "2026-01-01",
    targetDate: "2026-02-01",
  });

  const updated = await updateProject(testDb.ports, { key: "TAC", name: "Tactics v2" });

  assert.equal(updated.name, "Tactics v2");
  assert.equal(updated.summary, "Original summary");
  assert.equal(updated.description, "Original description");
  assert.equal(updated.status, "planned");
  assert.equal(updated.priority, 2);
  assert.equal(updated.startDate, "2026-01-01");
  assert.equal(updated.targetDate, "2026-02-01");
  assert.equal(updated.archivedAt, null);
});

test("updateProject clears priority and dates when passed null", async () => {
  await createProject(testDb.ports, {
    key: "TAC",
    name: "Tactics",
    priority: 1,
    startDate: "2026-01-01",
    targetDate: "2026-02-01",
  });

  const cleared = await updateProject(testDb.ports, {
    key: "TAC",
    priority: null,
    startDate: null,
    targetDate: null,
  });

  assert.equal(cleared.priority, null);
  assert.equal(cleared.startDate, null);
  assert.equal(cleared.targetDate, null);
  assert.equal(cleared.name, "Tactics");
});

test("updateProject archives and restores a project", async () => {
  await createProject(testDb.ports, { key: "ARC", name: "Archivable" });

  const archived = await updateProject(testDb.ports, { key: "ARC", archived: true });
  assert.ok(archived.archivedAt !== null);
  assert.deepEqual(await listProjects(testDb.ports), []);
  assert.deepEqual(
    (await listProjects(testDb.ports, { includeArchived: true })).map((project) => project.key),
    ["ARC"],
  );

  const restored = await updateProject(testDb.ports, { key: "ARC", archived: false });
  assert.equal(restored.archivedAt, null);
  assert.deepEqual(
    (await listProjects(testDb.ports)).map((project) => project.key),
    ["ARC"],
  );
});

test("updateProject rejects an unknown key with not_found", async () => {
  await assert.rejects(
    updateProject(testDb.ports, { key: "NOPE", name: "Ghost" }),
    rejectsWithServiceCode("not_found"),
  );
});

test("updateProject rejects an empty update with validation", async () => {
  await createProject(testDb.ports, { key: "TAC", name: "Tactics" });

  await assert.rejects(
    updateProject(testDb.ports, { key: "TAC" }),
    rejectsWithServiceCode("validation"),
  );
});

test("updateProject validates status, priority, dates, summary, and description", async () => {
  await createProject(testDb.ports, { key: "TAC", name: "Tactics" });

  const invalid: Array<Omit<UpdateProjectInput, "key">> = [
    { status: "started" },
    { priority: 5 },
    { startDate: "2026-02-31" },
    { summary: "x".repeat(256) },
    { description: "x".repeat(20001) },
  ];

  for (const fields of invalid) {
    await assert.rejects(
      updateProject(testDb.ports, { key: "TAC", ...fields }),
      rejectsWithServiceCode("validation"),
      `expected ${JSON.stringify(Object.keys(fields))} to be rejected`,
    );
  }
});

test("updateProject forbids non-human actors", async () => {
  await createProject(testDb.ports, { key: "TAC", name: "Tactics" });

  await assert.rejects(
    updateProject(testDb.ports, {
      key: "TAC",
      name: "Agent edit",
      actor: "agent",
      agent: "bot",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );
});

test("getProject reports progress across issue statuses", async () => {
  await createProject(testDb.ports, { key: "TAC", name: "Tactics" });

  await createIssue(testDb.ports, { project: "TAC", title: "Backlog" });
  await createIssue(testDb.ports, { project: "TAC", title: "Todo", status: "todo" });

  const inProgress = await createIssue(testDb.ports, {
    project: "TAC",
    title: "In progress",
    status: "todo",
  });
  await moveIssue(testDb.ports, {
    key: inProgress.key,
    to: "in_progress",
    actor: "human",
  });

  const inReview = await createIssue(testDb.ports, {
    project: "TAC",
    title: "In review",
    status: "todo",
  });
  await moveIssue(testDb.ports, {
    key: inReview.key,
    to: "in_progress",
    actor: "human",
  });
  await moveIssue(testDb.ports, {
    key: inReview.key,
    to: "in_review",
    actor: "human",
  });

  for (const title of ["Done one", "Done two"]) {
    const done = await createIssue(testDb.ports, {
      project: "TAC",
      title,
      status: "todo",
    });
    await moveIssue(testDb.ports, { key: done.key, to: "in_progress", actor: "human" });
    await moveIssue(testDb.ports, { key: done.key, to: "in_review", actor: "human" });
    await moveIssue(testDb.ports, { key: done.key, to: "done", actor: "human" });
  }

  const project = await getProject(testDb.ports, "TAC");

  assert.deepEqual(project.progress, {
    total: 6,
    done: 2,
    byStatus: { backlog: 1, todo: 1, in_progress: 1, in_review: 1, done: 2 },
  });
});
