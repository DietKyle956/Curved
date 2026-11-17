import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createEventHub } from "../src/adapters/postgres/event-hub.ts";
import type { EventHub } from "../src/application/ports.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

let testDb: TestDatabase;

before(async () => {
  testDb = await openTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
});

after(async () => {
  await testDb.close();
});

interface Recorder {
  values: number[];
  listener: (projectId: number) => void;
  /** Resolves once at least `count` notifications have arrived. */
  waitForCount(count: number): Promise<void>;
}

function recorder(): Recorder {
  const values: number[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const settle = (): void => {
    for (const waiter of [...waiters]) {
      if (values.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  return {
    values,
    listener: (projectId: number): void => {
      values.push(projectId);
      settle();
    },
    waitForCount: (count: number): Promise<void> => {
      if (values.length >= count) {
        return Promise.resolve();
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ count, resolve });
      return promise;
    },
  };
}

async function notify(payload: string): Promise<void> {
  await testDb.db.query("select pg_notify('issues_changed', $1)", [payload]);
}

async function listenClientCount(): Promise<number> {
  const rows = await testDb.db.query<{ count: string }>(
    `select count(*)::text as count
     from pg_stat_activity
     where datname = current_database()
       and pid <> pg_backend_pid()
       and query ilike 'LISTEN%issues_changed%'`,
  );
  return Number(rows[0]?.count ?? "0");
}

/**
 * The hub releases its client without awaiting `client.end()`, so the backend
 * disappears from `pg_stat_activity` slightly later. Poll the real database
 * state instead of guessing a fixed delay.
 */
async function waitForListenClientGone(): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if ((await listenClientCount()) === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for the LISTEN client to disconnect");
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(() => {
      resolve();
    }, 10);
    await promise;
  }
}

function openHub(logger?: (error: unknown) => void): EventHub {
  return createEventHub({
    databaseUrl: testDb.databaseUrl,
    ...(logger === undefined ? {} : { logger }),
  });
}

test("two subscriptions share one LISTEN client and both receive the numeric project id", async () => {
  const hub = openHub();
  try {
    const first = recorder();
    const second = recorder();
    const unsubscribeFirst = await hub.subscribe(first.listener);
    await hub.subscribe(second.listener);

    assert.deepEqual(hub.stats(), { subscribers: 2, clients: 1 });

    await notify("42");
    await first.waitForCount(1);
    await second.waitForCount(1);
    assert.deepEqual(first.values, [42]);
    assert.deepEqual(second.values, [42]);

    unsubscribeFirst();
    assert.deepEqual(hub.stats(), { subscribers: 1, clients: 1 });

    await notify("7");
    await second.waitForCount(2);
    assert.deepEqual(first.values, [42]);
    assert.deepEqual(second.values, [42, 7]);
  } finally {
    await hub.close();
  }
});

test("notifications with a non-numeric payload are ignored", async () => {
  const hub = openHub();
  try {
    const events = recorder();
    await hub.subscribe(events.listener);

    // Notifications are delivered in order on one connection, so once the
    // valid payload lands the invalid one has already been processed.
    await notify("not-a-number");
    await notify("11");
    await events.waitForCount(1);

    assert.deepEqual(events.values, [11]);
  } finally {
    await hub.close();
  }
});

test("a throwing listener is logged and does not break other subscribers", async () => {
  const errors: unknown[] = [];
  const hub = openHub((error) => {
    errors.push(error);
  });
  try {
    const healthy = recorder();
    await hub.subscribe(() => {
      throw new Error("listener exploded");
    });
    await hub.subscribe(healthy.listener);

    await notify("3");
    await healthy.waitForCount(1);

    assert.deepEqual(healthy.values, [3]);
    assert.equal(errors.length, 1);
  } finally {
    await hub.close();
  }
});

test("close is idempotent and releases the LISTEN client", async () => {
  const hub = openHub();
  try {
    const events = recorder();
    await hub.subscribe(events.listener);
    assert.deepEqual(hub.stats(), { subscribers: 1, clients: 1 });

    await hub.close();
    await hub.close();

    assert.deepEqual(hub.stats(), { subscribers: 0, clients: 0 });
    await waitForListenClientGone();

    await notify("9");
    assert.deepEqual(events.values, []);
  } finally {
    await hub.close();
  }
});
