import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createApp, type App } from "../src/http/app.ts";
import { createEventHub, type EventHub } from "../src/http/event-hub.ts";
import { commentOnIssue } from "../src/services/comments.ts";
import { createIssue, updateIssue } from "../src/application/issues.ts";
import { createProject } from "../src/application/projects.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const UI_TOKEN = "test-ui-token";
const SESSION_COOKIE_VALUE = createHash("sha256")
  .update(UI_TOKEN, "utf8")
  .digest("hex");
const COOKIE_HEADER = `curved_session=${SESSION_COOKIE_VALUE}`;
const PING_INTERVAL_MS = 50;
const FRAME_TIMEOUT_MS = 2000;

interface SseFrame {
  event: string;
  data: string;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Rejects instead of hanging when an expected frame never arrives. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const timer = Promise.withResolvers<never>();
  const handle = setTimeout(() => {
    timer.reject(new Error(message));
  }, timeoutMs);
  try {
    return await Promise.race([promise, timer.promise]);
  } finally {
    clearTimeout(handle);
  }
}

/** Incremental parser over a streaming response body. */
class EventStreamReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #queue: SseFrame[] = [];
  #cancelled = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  async nextFrame(timeoutMs = FRAME_TIMEOUT_MS): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        return queued;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("timed out waiting for an SSE frame");
      }
      const chunk = await withTimeout(
        this.#reader.read(),
        remaining,
        "timed out waiting for an SSE frame",
      );
      if (chunk.done) {
        throw new Error("SSE stream ended before the expected frame");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
      this.#drainFrames();
    }
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    try {
      await this.#reader.cancel();
    } catch {
      // The stream was already closed; nothing left to release.
    }
  }

  #drainFrames(): void {
    for (;;) {
      const boundary = this.#buffer.indexOf("\n\n");
      if (boundary === -1) {
        return;
      }
      const raw = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (clean.startsWith("event:")) {
          event = clean.slice("event:".length).trim();
        } else if (clean.startsWith("data:")) {
          data.push(clean.slice("data:".length).trim());
        }
      }
      this.#queue.push({ event, data: data.join("\n") });
    }
  }
}

function runCli(args: readonly string[]): Promise<CliResult> {
  const { promise, resolve: settle, reject } =
    Promise.withResolvers<CliResult>();
  const child = spawn(process.execPath, ["src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CURVED_AGENT_TOKEN: "",
      DATABASE_URL: testDb.databaseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const out = child.stdout;
  const err = child.stderr;
  if (out === null || err === null) {
    reject(new Error("spawned CLI without piped stdio"));
    return promise;
  }
  out.setEncoding("utf8");
  err.setEncoding("utf8");
  out.on("data", (chunk: string) => {
    stdout += chunk;
  });
  err.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => {
    settle({ code, stdout, stderr });
  });
  return promise;
}

let testDb: TestDatabase;
let hub: EventHub;
let app: App;
let hubOpened = false;
let appOpened = false;
let readers: EventStreamReader[] = [];

before(async () => {
  testDb = await openTestDatabase();
});

beforeEach(async () => {
  hubOpened = false;
  appOpened = false;
  readers = [];
  await testDb.reset();
  hub = createEventHub({
    databaseUrl: testDb.databaseUrl,
    logger: () => {},
  });
  hubOpened = true;
  app = createApp({
    db: testDb.db,
    ports: testDb.ports,
    databaseUrl: testDb.databaseUrl,
    uiToken: UI_TOKEN,
    events: hub,
    eventPingIntervalMs: PING_INTERVAL_MS,
    logger: () => {},
  });
  appOpened = true;
});

afterEach(async () => {
  for (const reader of readers) {
    await reader.cancel();
  }
  if (appOpened) {
    await app.close();
  }
  if (hubOpened) {
    await hub.close();
  }
});

after(async () => {
  await testDb.close();
});

function requestEventStream(
  headers?: Record<string, string>,
): Promise<Response> {
  return app.handle(
    new Request(
      new URL("/api/events", "http://localhost"),
      headers === undefined ? {} : { headers },
    ),
  );
}

async function openStream(): Promise<EventStreamReader> {
  const response = await requestEventStream({ cookie: COOKIE_HEADER });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body, "event stream response has no body");
  const reader = new EventStreamReader(body);
  readers.push(reader);
  return reader;
}

async function nextEvent(
  stream: EventStreamReader,
  event: string,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<SseFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for an "${event}" frame`);
    }
    const frame = await stream.nextFrame(remaining);
    if (frame.event === event) {
      return frame;
    }
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("the event stream requires the session cookie and ignores bearer tokens", async () => {
  const anonymous = await requestEventStream();
  assert.equal(anonymous.status, 401);
  assert.match(
    anonymous.headers.get("content-type") ?? "",
    /application\/json/,
  );
  assert.equal(
    (await readJson<{ error: { code: string } }>(anonymous)).error.code,
    "not_authenticated",
  );

  const bearer = await requestEventStream({
    authorization: `Bearer ${UI_TOKEN}`,
  });
  assert.equal(bearer.status, 401);
  assert.match(bearer.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(
    (await readJson<{ error: { code: string } }>(bearer)).error.code,
    "not_authenticated",
  );

  const response = await requestEventStream({ cookie: COOKIE_HEADER });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  assert.equal(
    response.headers.get("cache-control"),
    "no-cache, no-transform",
  );
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const body = response.body;
  assert.ok(body, "event stream response has no body");
  const reader = new EventStreamReader(body);
  readers.push(reader);
  assert.equal((await reader.nextFrame()).event, "ready");
  await reader.cancel();
});

test("the first frame is ready", async () => {
  const stream = await openStream();

  const frame = await stream.nextFrame();

  assert.deepEqual(frame, { event: "ready", data: "{}" });
});

test("an issue created by the CLI wakes the open stream within 1000 ms of exiting", async () => {
  const project = await createProject(testDb.ports, { key: "TAC", name: "Tactics" });
  const stream = await openStream();
  assert.equal((await stream.nextFrame()).event, "ready");

  const result = await runCli(["issue", "add", "TAC", "Live", "issue"]);
  assert.equal(result.code, 0, result.stderr);

  // Timing starts after the child exited, so a slow start does not count.
  const frame = await nextEvent(stream, "issues_changed", 1000);
  assert.equal(Number(frame.data), project.id);
});

test("a comment and an issue field update each wake the stream", async () => {
  const project = await createProject(testDb.ports, { key: "TAC", name: "Tactics" });
  const issue = await createIssue(testDb.ports, {
    project: "TAC",
    title: "Watch me",
  });
  const stream = await openStream();
  assert.equal((await stream.nextFrame()).event, "ready");

  await commentOnIssue(testDb.db, { key: issue.key, body: "hello" });
  const commentFrame = await nextEvent(stream, "issues_changed");
  assert.equal(Number(commentFrame.data), project.id);

  await updateIssue(testDb.ports, { key: issue.key, title: "Renamed" });
  const updateFrame = await nextEvent(stream, "issues_changed");
  assert.equal(Number(updateFrame.data), project.id);
});

test("ping frames arrive on the configured interval", async () => {
  const stream = await openStream();
  assert.equal((await stream.nextFrame()).event, "ready");

  const ping = await nextEvent(stream, "ping");
  assert.deepEqual(ping, { event: "ping", data: "{}" });
});

test("cancelling a stream releases its subscription while the hub keeps one LISTEN client", async () => {
  const first = await openStream();
  const second = await openStream();
  assert.equal((await first.nextFrame()).event, "ready");
  assert.equal((await second.nextFrame()).event, "ready");
  assert.deepEqual(hub.stats(), { subscribers: 2, clients: 1 });

  await first.cancel();
  assert.deepEqual(hub.stats(), { subscribers: 1, clients: 1 });

  await second.cancel();
  assert.deepEqual(hub.stats(), { subscribers: 0, clients: 1 });
});
