import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { runMigrations } from "../src/migrate.ts";
import { createTestDatabase, dropTestDatabase } from "./helpers/db.ts";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "..", "migrations");

/** Every migration version on disk, independent of how many exist today. */
async function migrationVersions(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name.slice(0, -".sql".length))
    .sort();
}

test("concurrent migration runs apply each migration exactly once", async () => {
  const name = `curved_test_concurrent_${process.pid}`;

  try {
    await dropTestDatabase(name);
    const databaseUrl = await createTestDatabase(name);

    const results = await Promise.all([
      runMigrations({ databaseUrl }),
      runMigrations({ databaseUrl }),
    ]);

    assert.deepEqual(results.flat().sort(), await migrationVersions());

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await client.query<{ count: number }>(
        "select count(*)::int as count from schema_migrations",
      );
      assert.equal(result.rows[0]?.count, (await migrationVersions()).length);
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

    assert.deepEqual(await runMigrations({ databaseUrl }), await migrationVersions());
    assert.deepEqual(await runMigrations({ databaseUrl }), []);
  } finally {
    await dropTestDatabase(name);
  }
});
