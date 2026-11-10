import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db.ts";
import { createApp } from "./http/app.ts";

function toRequest(request: IncomingMessage): Request {
  const method = request.method ?? "GET";
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }

  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as unknown as AsyncIterable<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  outgoing.statusCode = response.status;

  const setCookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      return;
    }
    outgoing.setHeader(name, value);
  });
  if (setCookies.length > 0) {
    outgoing.setHeader("set-cookie", setCookies);
  }

  if (
    response.status === 204 ||
    response.status === 304 ||
    response.body === null
  ) {
    outgoing.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (!outgoing.hasHeader("content-length")) {
    outgoing.setHeader("content-length", String(body.byteLength));
  }
  outgoing.end(body);
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.uiToken === "") {
    process.stderr.write(
      "CURVED_UI_TOKEN is required to start the HTTP server\n",
    );
    process.exit(1);
  }

  const db = createDatabase(config.databaseUrl);
  const app = createApp({ db, uiToken: config.uiToken });

  const server = createServer((incoming, outgoing) => {
    void app
      .handle(toRequest(incoming))
      .then((response) => writeResponse(response, outgoing))
      .catch((error: unknown) => {
        console.error(error);
        if (!outgoing.headersSent) {
          outgoing.statusCode = 500;
          outgoing.setHeader("content-type", "text/plain; charset=utf-8");
          outgoing.end("Internal Server Error\n");
        } else {
          outgoing.destroy();
        }
      });
  });

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
    server.close(() => {
      void db.close().then(
        () => {
          process.exit(0);
        },
        () => {
          process.exit(0);
        },
      );
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
