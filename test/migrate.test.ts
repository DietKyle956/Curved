import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { runMigrations } from "../src/migrate.ts";
import { createTestDatabase, dropTestDatabase } from "./helpers/db.ts";

test("concurrent migration runs apply each migration exactly once", async () => {
  const name = `curved_test_concurrent_${process.pid}`;

  try {
    await dropTestDatabase(name);
    const databaseUrl = await createTestDatabase(name);

    const results = await Promise.all([
      runMigrations({ databaseUrl }),
      runMigrations({ databaseUrl }),
    ]);

    assert.deepEqual(results.flat().sort(), ["0001_projects"]);

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await client.query<{ count: number }>(
        "select count(*)::int as count from schema_migrations",
      );
      assert.equal(result.rows[0]?.count, 1);
    } finally {
      await client.end();
    }
  } finally {
    await dropTestDatabase(name);
  }
});

test("a sequential migration run after bootstrap applies nothing", async () => {
  const name = `curved_test_sequential_${process.pid}`;

  try {
    await dropTestDatabase(name);
    const databaseUrl = await createTestDatabase(name);

    assert.deepEqual(await runMigrations({ databaseUrl }), ["0001_projects"]);
    assert.deepEqual(await runMigrations({ databaseUrl }), []);
  } finally {
    await dropTestDatabase(name);
  }
});
