import pg from "pg";
import type { Notification } from "pg";
import type { EventHub } from "../../application/ports.ts";

/** The Postgres channel carrying a project id whenever its issues change. */
export const ISSUES_CHANGED_CHANNEL = "issues_changed";

/** How long a broken LISTEN connection waits before it is retried. */
const RECONNECT_DELAY_MS = 1000;

/** Upper bound on how long closing waits for a socket to finish ending. */
const CLIENT_END_TIMEOUT_MS = 1000;

export function createEventHub(options: {
  databaseUrl: string;
  logger?: (error: unknown) => void;
}): EventHub {
  const logger =
    options.logger ??
    ((error: unknown) => {
      console.error(error);
    });

  const subscribers = new Set<(projectId: number) => void>();
  /** Clients the hub has already given up on, including mid-handshake deaths. */
  const retired = new WeakSet<pg.Client>();
  let client: pg.Client | null = null;
  let connecting: Promise<pg.Client> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let closing: Promise<void> | null = null;
  let closed = false;

  /** Remove every handler, then wait (briefly) for the socket to close. */
  function endClient(target: pg.Client): Promise<void> {
    retired.add(target);
    target.removeAllListeners("notification");
    target.removeAllListeners("end");
    target.removeAllListeners("error");
    // A client that is still tearing down can emit a late error; swallow it so
    // it never reaches the process as an unhandled "error" event.
    target.on("error", () => {});
    const finish = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      finish.resolve();
    }, CLIENT_END_TIMEOUT_MS);
    timer.unref();
    const settle = (): void => {
      clearTimeout(timer);
      finish.resolve();
    };
    try {
      void target.end().then(settle, settle);
    } catch {
      // A client that never opened a socket has nothing to release.
      settle();
    }
    return finish.promise;
  }

  /** Forgets a client without waiting; used on paths that must not block. */
  function detach(target: pg.Client): void {
    void endClient(target);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function publish(payload: string): void {
    if (!/^\d+$/.test(payload)) {
      return;
    }
    const projectId = Number(payload);
    if (!Number.isSafeInteger(projectId)) {
      return;
    }
    for (const listener of [...subscribers]) {
      try {
        listener(projectId);
      } catch (error) {
        logger(error);
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null || subscribers.size === 0) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed || subscribers.size === 0 || client !== null) {
        return;
      }
      void ensureClient().catch((error: unknown) => {
        logger(error);
        scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
    reconnectTimer.unref();
  }

  /** Forgets a client that died or closed underneath us. */
  function forget(target: pg.Client): void {
    if (client === target) {
      client = null;
    }
    detach(target);
    scheduleReconnect();
  }

  async function startClient(): Promise<pg.Client> {
    const next = new pg.Client({ connectionString: options.databaseUrl });
    next.on("notification", (message: Notification) => {
      publish(message.payload ?? "");
    });
    next.on("error", (error: Error) => {
      logger(error);
      forget(next);
    });
    next.on("end", () => {
      forget(next);
    });
    try {
      await next.connect();
      await next.query(`listen ${ISSUES_CHANGED_CHANNEL}`);
    } catch (error) {
      detach(next);
      throw error;
    }
    return next;
  }

  function ensureClient(): Promise<pg.Client> {
    if (closed) {
      return Promise.reject(new Error("event hub is closed"));
    }
    if (client !== null) {
      return Promise.resolve(client);
    }
    if (connecting !== null) {
      return connecting;
    }
    const pending = startClient().then(
      (next) => {
        connecting = null;
        // `forget` can retire a client that died during the LISTEN handshake.
        if (closed || retired.has(next)) {
          detach(next);
          throw new Error("event hub connection failed");
        }
        client = next;
        clearReconnectTimer();
        return next;
      },
      (error: unknown) => {
        connecting = null;
        // Subscribers stay registered across a failed connect, so retry while
        // anyone is still listening instead of waiting for the next subscribe.
        scheduleReconnect();
        throw error;
      },
    );
    connecting = pending;
    return pending;
  }

  function removeSubscriber(listener: (projectId: number) => void): void {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      clearReconnectTimer();
    }
  }

  async function subscribe(
    listener: (projectId: number) => void,
  ): Promise<() => void> {
    if (closed) {
      throw new Error("event hub is closed");
    }
    subscribers.add(listener);
    try {
      await ensureClient();
    } catch (error) {
      removeSubscriber(listener);
      throw error;
    }

    let done = false;
    return () => {
      if (done) {
        return;
      }
      done = true;
      removeSubscriber(listener);
    };
  }

  async function shutdown(): Promise<void> {
    closed = true;
    clearReconnectTimer();
    subscribers.clear();
    const target = client;
    client = null;
    connecting = null;
    if (target !== null) {
      await endClient(target);
    }
  }

  function close(): Promise<void> {
    if (closing === null) {
      closing = shutdown();
    }
    return closing;
  }

  return {
    subscribe,
    stats: () => ({
      subscribers: subscribers.size,
      clients: client === null ? 0 : 1,
    }),
    close,
  };
}
