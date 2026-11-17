import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import type { Client } from "pg";

/** Advisory lock key shared by every migration runner against one database. */
const MIGRATION_LOCK_KEY = 727274;

interface MigrationFile {
  version: string;
  path: string;
}

/**
 * Reads `*.sql` files and returns them in lexicographic order. The version is
 * the file name without its `.sql` suffix, so `0001_projects.sql` is recorded
 * in `schema_migrations` as `0001_projects`.
 */
async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => ({
      version: entry.name.slice(0, -".sql".length),
      path: resolve(directory, entry.name),
    }))
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function alreadyApplied(client: Client): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    "select version from schema_migrations",
  );
  return new Set(result.rows.map((row) => row.version));
}

async function applyMigration(
  client: Client,
  migration: MigrationFile,
): Promise<void> {
  const sql = await readFile(migration.path, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("insert into schema_migrations (version) values ($1)", [
      migration.version,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Applies every pending migration and returns the versions applied by this
 * run. One transaction per file; a session advisory lock serializes runners.
 */
export async function runMigrations(options: {
  databaseUrl: string;
  migrationsDir?: string;
}): Promise<string[]> {
  const migrationsDir =
    options.migrationsDir ??
    resolve(import.meta.dirname, "..", "..", "..", "migrations");

  const migrations = await readMigrationFiles(migrationsDir);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();

  let locked = false;
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    locked = true;

    await ensureLedger(client);
    const done = await alreadyApplied(client);
    for (const migration of migrations) {
      if (done.has(migration.version)) {
        continue;
      }
      await applyMigration(client, migration);
      applied.push(migration.version);
    }
  } finally {
    try {
      if (locked) {
        await client.query("select pg_advisory_unlock($1)", [
          MIGRATION_LOCK_KEY,
        ]);
      }
    } finally {
      await client.end();
    }
  }

  return applied;
}
