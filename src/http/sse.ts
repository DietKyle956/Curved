import type { EventHub } from "./event-hub.ts";

/** How often an idle stream emits a comment-free keep-alive frame. */
export const SSE_PING_INTERVAL_MS = 25_000;

const READY_FRAME = "event: ready\ndata: {}\n\n";
const PING_FRAME = "event: ping\ndata: {}\n\n";

/**
 * Streams issue-change notifications for the caller's projects. The stream
 * emits `ready` only after the hub subscription exists, then one
 * `issues_changed` frame per notification and a periodic `ping`. Both the
 * request abort and a consumer cancel tear the subscription down exactly once.
 */
export function createEventStreamResponse(options: {
  request: Request;
  hub: EventHub;
  pingIntervalMs?: number;
  logger?: (error: unknown) => void;
}): Response {
  const logger =
    options.logger ??
    ((error: unknown) => {
      console.error(error);
    });
  const pingIntervalMs = options.pingIntervalMs ?? SSE_PING_INTERVAL_MS;
  const encoder = new TextEncoder();
  const signal = options.request.signal;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unsubscribe: (() => void) | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function clearPingTimer(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function releaseSubscription(): void {
    const stop = unsubscribe;
    unsubscribe = null;
    if (stop === null) {
      return;
    }
    try {
      stop();
    } catch (error) {
      logger(error);
    }
  }

  function shutdown(): void {
    if (closed) {
      return;
    }
    closed = true;
    clearPingTimer();
    signal.removeEventListener("abort", onAbort);
    releaseSubscription();
    const open = controller;
    controller = null;
    if (open !== null) {
      try {
        open.close();
      } catch {
        // The consumer already closed the stream; nothing is left to release.
      }
    }
  }

  function onAbort(): void {
    shutdown();
  }

  function send(frame: string): void {
    if (closed || controller === null) {
      return;
    }
    try {
      controller.enqueue(encoder.encode(frame));
    } catch (error) {
      logger(error);
      shutdown();
    }
  }

  function onProjectChanged(projectId: number): void {
    send(`event: issues_changed\ndata: ${projectId}\n\n`);
  }

  const body = new ReadableStream<Uint8Array>({
    async start(streamController) {
      controller = streamController;
      if (signal.aborted) {
        shutdown();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      let stop: () => void;
      try {
        stop = await options.hub.subscribe(onProjectChanged);
      } catch (error) {
        logger(error);
        shutdown();
        return;
      }

      if (closed) {
        // Aborted or cancelled while the subscription was being set up.
        try {
          stop();
        } catch (error) {
          logger(error);
        }
        return;
      }

      unsubscribe = stop;
      send(READY_FRAME);
      pingTimer = setInterval(() => {
        send(PING_FRAME);
      }, pingIntervalMs);
      pingTimer.unref();
    },
    cancel() {
      shutdown();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
