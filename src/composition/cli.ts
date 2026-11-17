import { loadConfig } from "./config.ts";
import { runCli } from "../adapters/cli/cli.ts";
import { runMigrations } from "../adapters/postgres/migrate.ts";
import { createDatabase } from "../adapters/postgres/pool.ts";
import { createPorts } from "../adapters/postgres/ports.ts";
import type { Ports } from "../application/ports.ts";

const config = loadConfig();

process.exitCode = await runCli(process.argv.slice(2), {
  agentToken: config.agentToken,
  async withPorts<T>(fn: (ports: Ports) => Promise<T>): Promise<T> {
    const db = createDatabase(config.databaseUrl);
    try {
      return await fn(createPorts(db));
    } finally {
      await db.close();
    }
  },
  migrate: () => runMigrations({ databaseUrl: config.databaseUrl }),
});
