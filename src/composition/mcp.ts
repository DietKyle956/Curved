import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.ts";
import {
  createCurvedMcpServer,
  resolveAgentFromToken,
} from "../adapters/mcp/server.ts";
import { createDatabase } from "../adapters/postgres/pool.ts";
import { createPorts } from "../adapters/postgres/ports.ts";

/** Serves MCP over stdio until stdin ends or the process is signalled. */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  const ports = createPorts(db);
  const handle = serveStdio(
    () =>
      createCurvedMcpServer({
        ports,
        resolveAgent: () => resolveAgentFromToken(ports, config.agentToken),
      }),
    {
      onerror: (error) => {
        process.stderr.write(`curved mcp: ${error.message}\n`);
      },
    },
  );

  let closing: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (closing === null) {
      closing = (async () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.stdin.off("end", onStdinEnd);
        await handle.close();
        await db.close();
      })();
    }
    return closing;
  };
  const onSignal = (): void => {
    void shutdown();
  };
  const onStdinEnd = (): void => {
    void shutdown();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.stdin.on("end", onStdinEnd);
}

await main();
