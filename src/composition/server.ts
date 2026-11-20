import { loadConfig } from "./config.ts";
import { createDatabase } from "../adapters/postgres/pool.ts";
import { createPorts } from "../adapters/postgres/ports.ts";
import { createEventHub } from "../adapters/postgres/event-hub.ts";
import { createApp } from "../adapters/http/app.ts";
import { createNodeServer } from "../adapters/http/transport.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.uiToken === "") {
    process.stderr.write(
      "CURVED_UI_TOKEN is required to start the HTTP server\n",
    );
    process.exit(1);
  }

  const db = createDatabase(config.databaseUrl);
  const ports = createPorts(db);
  const hub = createEventHub({ databaseUrl: config.databaseUrl });
  const app = createApp({
    ports,
    events: hub,
    uiToken: config.uiToken,
    webhookSecret: config.webhookSecret,
    cookieSecure: config.cookieSecure,
    webauthn: config.webauthn,
  });

  const server = createNodeServer(app);

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(config.port, () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;
  process.stdout.write(
    `curved listening on http://127.0.0.1:${config.port}\n`,
  );

  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void (async () => {
      try {
        await hub.close();
      } catch (error: unknown) {
        console.error(error);
      }
      const closed = Promise.withResolvers<void>();
      server.close(() => {
        closed.resolve();
      });
      server.closeAllConnections();
      await closed.promise;
      void db.close().then(
        () => {
          process.exit(0);
        },
        () => {
          process.exit(0);
        },
      );
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
