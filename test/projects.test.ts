import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ServiceError, type ErrorCode } from "../src/domain/errors.ts";
import { createProject, listProjects } from "../src/application/projects.ts";
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
