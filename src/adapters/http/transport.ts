import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { App } from "./app.ts";

export function toRequest(
  request: IncomingMessage,
  signal: AbortSignal,
): Request {
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

  const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as unknown as AsyncIterable<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

function waitForDrain(outgoing: ServerResponse): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const settle = (): void => {
    outgoing.off("drain", settle);
    outgoing.off("close", settle);
    resolve();
  };
  outgoing.on("drain", settle);
  outgoing.on("close", settle);
  return promise;
}

export async function streamEventStream(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  const body = response.body;
  if (body === null) {
    outgoing.end();
    return;
  }

  outgoing.flushHeaders();

  const reader = body.getReader();
  let closed = false;
  const onClose = (): void => {
    closed = true;
  };
  outgoing.once("close", onClose);

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (closed) {
        break;
      }
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      if (!outgoing.write(Buffer.from(value))) {
        await waitForDrain(outgoing);
      }
    }
  } finally {
    outgoing.off("close", onClose);
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored; nothing to clean up.
    }
    reader.releaseLock();
  }

  if (!outgoing.writableEnded && !outgoing.destroyed) {
    outgoing.end();
  }
}

export async function writeResponse(
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

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("text/event-stream")) {
    await streamEventStream(response, outgoing);
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (!outgoing.hasHeader("content-length")) {
    outgoing.setHeader("content-length", String(body.byteLength));
  }
  outgoing.end(body);
}

/** Bridges Node's HTTP server onto an {@link App}. */
export function createNodeServer(app: App): Server {
  return createServer((incoming, outgoing) => {
    const abort = new AbortController();
    const onDisconnect = (): void => {
      abort.abort();
    };
    incoming.once("aborted", onDisconnect);
    outgoing.once("close", onDisconnect);

    void app
      .handle(toRequest(incoming, abort.signal))
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
      })
      .finally(() => {
        incoming.off("aborted", onDisconnect);
      });
  });
}
