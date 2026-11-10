import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";

/**
 * The single-statement database surface. Services depend on this, never on the
 * pool directly, so they can run inside or outside a transaction unchanged.
 */
export interface Db {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | null>;
}

/**
 * A pool with transactions. Every multi-statement invariant must run inside
 * `tx`; single statements use `query` or `one`.
 */
export interface Database extends Db {
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Runner = pg.Pool | PoolClient;

class RunnerDb implements Db {
  readonly runner: Runner;

  constructor(runner: Runner) {
    this.runner = runner;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.runner.query<T>(
      sql,
      params === undefined ? undefined : [...params],
    );
    return result.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
}

class PoolDatabase implements Database {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(
      sql,
      params === undefined ? undefined : [...params],
    );
    return result.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const inner = new RunnerDb(client);
    try {
      await client.query("begin");
      const result = await fn(inner);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // The connection is already broken; the original error is the one that matters.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabase(connectionString: string): Database {
  return new PoolDatabase(connectionString);
}

/** Returns a Postgres SQLSTATE such as `23505` when the error carries one. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
