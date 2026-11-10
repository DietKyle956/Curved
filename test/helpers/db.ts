import pg from "pg";
import { loadConfig } from "../../src/config.ts";
import { createDatabase, type Database } from "../../src/db.ts";
import { runMigrations } from "../../src/migrate.ts";

export interface TestDatabase {
  db: Database;
  databaseUrl: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const TEST_DATABASE_PREFIX = "curved_test";
const ADMIN_DATABASE = "postgres";

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function adminUrlFor(url: URL): string {
  const admin = new URL(url.toString());
  admin.pathname = `/${ADMIN_DATABASE}`;
  return admin.toString();
}

function assertTestDatabaseName(name: string): void {
  if (!name.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error(
      `Refusing to use database "${name}": the name must start with "${TEST_DATABASE_PREFIX}"`,
    );
  }
}

/**
 * Creates `name` when absent on the same server as `TEST_DATABASE_URL` and
 * returns that database's URL, reusing the configured credentials and host.
 * Refuses names without the `curved_test` prefix so real data is never at risk.
 */
export async function createTestDatabase(name: string): Promise<string> {
  assertTestDatabaseName(name);

  const server = new URL(loadConfig().testDatabaseUrl);
  const target = new URL(server.toString());
  target.pathname = `/${encodeURIComponent(name)}`;
  const databaseUrl = target.toString();

  const admin = new pg.Client({ connectionString: adminUrlFor(server) });
  await admin.connect();
  try {
    const existing = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    }
  } finally {
    await admin.end();
  }

  return databaseUrl;
}

/**
 * Terminates any backends still connected to `name` and drops the database.
 * Used by tests that own a throwaway database.
 */
export async function dropTestDatabase(name: string): Promise<void> {
  assertTestDatabaseName(name);

  const admin = new pg.Client({
    connectionString: adminUrlFor(new URL(loadConfig().testDatabaseUrl)),
  });
  await admin.connect();
  try {
    await admin.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`drop database if exists ${quoteIdentifier(name)}`);
  } finally {
    await admin.end();
  }
}

/**
 * Connects to the configured test database, creating it and applying
 * migrations when needed. Refuses to run against any database whose name does
 * not start with `curved_test`.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const { testDatabaseUrl } = loadConfig();
  const name = decodeURIComponent(
    new URL(testDatabaseUrl).pathname.replace(/^\/+/, ""),
  );

  const databaseUrl = await createTestDatabase(name);
  await runMigrations({ databaseUrl });

  const db = createDatabase(databaseUrl);
  return {
    db,
    databaseUrl,
    async reset(): Promise<void> {
      await db.query("TRUNCATE projects RESTART IDENTITY CASCADE");
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
