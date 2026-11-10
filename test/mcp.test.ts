import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, beforeEach, test } from "node:test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAgent } from "../src/services/agents.ts";
import { createIssue, type Issue } from "../src/services/issues.ts";
import { createProject } from "../src/services/projects.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SERVER_ENTRY = "src/mcp/main.ts";
const AGENT_NAME = "alice";

const TOOL_NAMES = [
  "claim_next",
  "comment",
  "create_issue",
  "get_issue",
  "list_ready",
  "mark_blocked",
  "release_claim",
  "submit_for_review",
] as const;

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

interface IssuePayload {
  id: number;
  key: string;
  projectKey: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: number;
  parentId: number | null;
  blockedReason: string | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventPayload {
  id: number;
  issueId: number;
  kind: string;
  actorType: string;
  fromStatus: string | null;
  toStatus: string | null;
  body: string | null;
  createdAt: string;
}

interface TimelinePayload {
  issue: IssuePayload;
  events: EventPayload[];
}

interface ReadyPayload {
  ready: IssuePayload[];
  busy: string | null;
}

interface McpSession {
  client: Client;
  transport: StdioClientTransport;
}

async function seedProject(key = "TAC", name = "Tac"): Promise<void> {
  await createProject(testDb.db, { key, name });
}

async function seedAgentToken(name = AGENT_NAME): Promise<string> {
  const created = await createAgent(testDb.db, name);
  return created.token;
}

async function seedIssue(
  title: string,
  project = "TAC",
  priority = 3,
): Promise<Issue> {
  return createIssue(testDb.db, { project, title, status: "todo", priority });
}

function childEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      inherited[key] = value;
    }
  }
  return {
    ...inherited,
    DATABASE_URL: testDb.databaseUrl,
    TEST_DATABASE_URL: testDb.databaseUrl,
    CURVED_AGENT_TOKEN: "",
    ...overrides,
  };
}

function textOf(result: CallToolResult): string {
  const content = result.content[0];
  if (content === undefined || content.type !== "text") {
    assert.fail("tool result has no text content");
  }
  return content.text;
}

async function callOk<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result)) as T;
}

async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, textOf(result));
  return textOf(result);
}

async function assertInputValidationError(
  promise: Promise<CallToolResult>,
): Promise<void> {
  const result = await promise;
  const text = textOf(result);
  assert.equal(result.isError, true, text);
  assert.match(text, /^Input validation error: Invalid arguments for tool /);
}

async function connectMcp(token: string): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: REPO_ROOT,
    env: childEnv({ CURVED_AGENT_TOKEN: token }),
    stderr: "pipe",
  });
  const stderr = transport.stderr;
  if (stderr !== null) {
    stderr.on("data", () => {});
  }
  const client = new Client({ name: "curved-mcp-test", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return { client, transport };
}

async function closeMcp(session: McpSession): Promise<void> {
  try {
    await session.client.close();
  } finally {
    await session.transport.close();
  }
}

async function claimFirst(client: Client): Promise<TimelinePayload> {
  return callOk<TimelinePayload>(client, "claim_next", {});
}

interface RawMessage {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RawWaiter {
  resolve: (message: RawMessage) => void;
  reject: (error: Error) => void;
}

interface RawServer {
  lines: string[];
  request(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<RawMessage>;
  notify(method: string): void;
  finish(): Promise<void>;
}

function startRawServer(token: string): RawServer {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: childEnv({ CURVED_AGENT_TOKEN: token }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    assert.fail("spawned MCP server without piped stdio");
  }

  const lines: string[] = [];
  const pending = new Map<number, RawWaiter>();
  const reader = createInterface({ input: stdout });
  let stderrText = "";
  let parseFailure: Error | null = null;

  stdin.on("error", () => {});
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  reader.on("line", (line) => {
    lines.push(line);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      const failure = new Error(`stdout line is not JSON: ${line}`, {
        cause: error,
      });
      parseFailure = failure;
      for (const waiter of pending.values()) {
        waiter.reject(failure);
      }
      pending.clear();
      return;
    }
    if (typeof message !== "object" || message === null) {
      return;
    }
    // Stdout carries only our own server's JSON-RPC; the fields read here are
    // the protocol envelope, which the assertions at the end re-validate.
    const response = message as RawMessage;
    if (typeof response.id !== "number") {
      return;
    }
    const waiter = pending.get(response.id);
    if (waiter === undefined) {
      return;
    }
    pending.delete(response.id);
    waiter.resolve(response);
  });

  const { promise: exited, resolve: settleExited } = Promise.withResolvers<{
    code: number | null;
    error: Error | null;
  }>();
  let settled = false;
  const settle = (value: { code: number | null; error: Error | null }) => {
    if (!settled) {
      settled = true;
      settleExited(value);
    }
  };
  child.on("error", (error) => settle({ code: null, error }));
  child.on("close", (code) => settle({ code, error: null }));

  child.on("close", (code) => {
    const error = new Error(
      `MCP server exited with code ${code}\n${stderrText}`,
    );
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  function write(message: Record<string, unknown>): void {
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<RawMessage> {
    if (parseFailure !== null) {
      return Promise.reject(parseFailure);
    }
    const { promise, resolve, reject } = Promise.withResolvers<RawMessage>();
    // A deadline guard, not synchronization: it only fires when the server
    // never answers, so a broken handshake cannot hang the suite.
    AbortSignal.timeout(15_000).addEventListener(
      "abort",
      () => {
        pending.delete(id);
        reject(new Error(`timed out waiting for "${method}"\n${stderrText}`));
      },
      { once: true },
    );
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  let finished: Promise<void> | undefined;

  function finish(): Promise<void> {
    finished ??= (async () => {
      stdin.end();
      // Cleanup guard only: the server exits on stdin EOF, and this stops a
      // wedged child from outliving the test.
      AbortSignal.timeout(10_000).addEventListener(
        "abort",
        () => {
          child.kill();
        },
        { once: true },
      );
      const result = await exited;
      reader.close();
      if (result.error !== null) {
        throw result.error;
      }
      if (result.code !== 0) {
        throw new Error(
          `MCP server exited with code ${result.code}\n${stderrText}`,
        );
      }
    })();
    return finished;
  }

  return {
    lines,
    request,
    notify(method) {
      write({ jsonrpc: "2.0", method });
    },
    finish,
  };
}

test(
  "the stdio server speaks JSON-RPC and lists exactly the eight tools",
  { timeout: 30_000 },
  async () => {
    const token = await seedAgentToken();
    const server = startRawServer(token);
    try {
      const initialized = await server.request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "curved-test", version: "0.0.0" },
      });
      assert.equal(initialized.jsonrpc, "2.0");
      assert.equal(initialized.error, undefined);
      const initResult = initialized.result as { protocolVersion?: unknown };
      assert.equal(typeof initResult.protocolVersion, "string");

      server.notify("notifications/initialized");

      const listed = await server.request(2, "tools/list", {});
      assert.equal(listed.error, undefined);
      const listResult = listed.result as { tools: { name: string }[] };
      assert.deepEqual(
        listResult.tools.map((tool) => tool.name).sort(),
        [...TOOL_NAMES].sort(),
      );
    } finally {
      await server.finish();
    }

    assert.ok(
      server.lines.length >= 2,
      "expected protocol responses on stdout",
    );
    for (const line of server.lines) {
      const message = JSON.parse(line) as { jsonrpc?: unknown };
      assert.equal(message.jsonrpc, "2.0", line);
    }
  },
);

test(
  "list_ready reports the backlog, filters by project, and rejects an unknown project",
  { timeout: 30_000 },
  async () => {
    await seedProject("TAC", "Tac");
    await seedProject("OPS", "Ops");
    const token = await seedAgentToken();
    await seedIssue("second", "TAC", 2);
    await seedIssue("first", "TAC", 1);
    await seedIssue("ops work", "OPS", 3);

    const session = await connectMcp(token);
    try {
      const queue = await callOk<ReadyPayload>(
        session.client,
        "list_ready",
        {},
      );
      assert.equal(queue.busy, null);
      assert.deepEqual(
        queue.ready.map((issue) => issue.key).sort(),
        ["OPS-1", "TAC-1", "TAC-2"],
      );

      const filtered = await callOk<ReadyPayload>(
        session.client,
        "list_ready",
        { project: "OPS" },
      );
      assert.equal(filtered.busy, null);
      assert.deepEqual(
        filtered.ready.map((issue) => issue.key),
        ["OPS-1"],
      );

      const error = await callError(session.client, "list_ready", {
        project: "ZZZ",
      });
      assert.ok(error.startsWith("not_found: "), error);
      assert.ok(error.includes("ZZZ"), error);
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "claim_next fails with no_ready_issue on an empty queue",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();

    const session = await connectMcp(token);
    try {
      const error = await callError(session.client, "claim_next", {});
      assert.ok(error.startsWith("no_ready_issue: "), error);
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "claim_next claims the ready issue and reports agent_busy while it is held",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();
    await seedIssue("first");
    await seedIssue("second");

    const session = await connectMcp(token);
    try {
      const claimed = await claimFirst(session.client);
      assert.equal(claimed.issue.key, "TAC-1");
      assert.equal(claimed.issue.status, "in_progress");
      assert.equal(claimed.issue.claimedBy, AGENT_NAME);
      assert.ok(
        claimed.events.some(
          (event) =>
            event.kind === "claim" &&
            event.actorType === "agent" &&
            event.toStatus === "in_progress",
        ),
        "claim event is missing",
      );

      const busy = await callError(session.client, "claim_next", {});
      assert.ok(busy.startsWith("agent_busy: "), busy);
      assert.ok(busy.includes("TAC-1"), busy);

      const queue = await callOk<ReadyPayload>(
        session.client,
        "list_ready",
        {},
      );
      assert.equal(queue.busy, "TAC-1");
      assert.deepEqual(
        queue.ready.map((issue) => issue.key),
        ["TAC-2"],
      );
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "comment appends an event that get_issue returns",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();
    await seedIssue("comment target");

    const session = await connectMcp(token);
    try {
      const claimed = await claimFirst(session.client);
      const key = claimed.issue.key;

      const event = await callOk<EventPayload>(session.client, "comment", {
        key,
        body: "please add tests",
      });
      assert.equal(event.kind, "comment");
      assert.equal(event.actorType, "agent");
      assert.equal(event.body, "please add tests");

      const timeline = await callOk<TimelinePayload>(
        session.client,
        "get_issue",
        { key },
      );
      assert.ok(
        timeline.events.some(
          (candidate) =>
            candidate.id === event.id && candidate.kind === "comment",
        ),
        "comment event is missing from the timeline",
      );
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "submit_for_review moves the claimed issue to in_review",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();
    await seedIssue("review target");

    const session = await connectMcp(token);
    try {
      const claimed = await claimFirst(session.client);
      const key = claimed.issue.key;

      const reviewed = await callOk<IssuePayload>(
        session.client,
        "submit_for_review",
        { key, summary: "ready for review" },
      );
      assert.equal(reviewed.status, "in_review");
      assert.equal(reviewed.claimedBy, AGENT_NAME);

      const timeline = await callOk<TimelinePayload>(
        session.client,
        "get_issue",
        { key },
      );
      assert.ok(
        timeline.events.some(
          (event) =>
            event.kind === "review_submitted" &&
            event.toStatus === "in_review" &&
            event.body === "ready for review",
        ),
        "review_submitted event is missing",
      );
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "release_claim returns the claimed issue to the ready backlog",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();
    await seedIssue("release target");

    const session = await connectMcp(token);
    try {
      const claimed = await claimFirst(session.client);
      const key = claimed.issue.key;

      const released = await callOk<IssuePayload>(
        session.client,
        "release_claim",
        { key },
      );
      assert.equal(released.status, "todo");
      assert.equal(released.claimedBy, null);

      const queue = await callOk<ReadyPayload>(
        session.client,
        "list_ready",
        {},
      );
      assert.equal(queue.busy, null);
      assert.deepEqual(
        queue.ready.map((issue) => issue.key),
        [key],
      );
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "mark_blocked releases the claim, records the reason, and removes readiness",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();
    await seedIssue("blocked target");

    const session = await connectMcp(token);
    try {
      const claimed = await claimFirst(session.client);
      const key = claimed.issue.key;

      const blocked = await callOk<IssuePayload>(
        session.client,
        "mark_blocked",
        { key, reason: "waiting on the API" },
      );
      assert.equal(blocked.status, "todo");
      assert.equal(blocked.claimedBy, null);
      assert.equal(blocked.blockedReason, "waiting on the API");

      const timeline = await callOk<TimelinePayload>(
        session.client,
        "get_issue",
        { key },
      );
      assert.ok(
        timeline.events.some(
          (event) =>
            event.kind === "blocked" &&
            event.body === "waiting on the API",
        ),
        "blocked event is missing",
      );

      const queue = await callOk<ReadyPayload>(
        session.client,
        "list_ready",
        {},
      );
      assert.equal(queue.busy, null);
      assert.deepEqual(queue.ready.map((issue) => issue.key), []);
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "create_issue returns the created issue and get_issue returns its created event",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();

    const session = await connectMcp(token);
    try {
      const created = await callOk<IssuePayload>(
        session.client,
        "create_issue",
        {
          project: "TAC",
          title: "Wire up the dashboard",
          description: "Show the backlog counts",
          priority: 2,
        },
      );
      assert.equal(created.key, "TAC-1");
      assert.equal(created.projectKey, "TAC");
      assert.equal(created.number, 1);
      assert.equal(created.title, "Wire up the dashboard");
      assert.equal(created.description, "Show the backlog counts");
      assert.equal(created.priority, 2);

      const timeline = await callOk<TimelinePayload>(
        session.client,
        "get_issue",
        { key: created.key },
      );
      assert.equal(timeline.issue.key, "TAC-1");
      assert.ok(
        timeline.events.some((event) => event.kind === "created"),
        "created event is missing",
      );
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "a blank CURVED_AGENT_TOKEN yields not_authenticated naming the variable",
  { timeout: 30_000 },
  async () => {
    const session = await connectMcp("");
    try {
      const error = await callError(session.client, "list_ready", {});
      assert.ok(error.startsWith("not_authenticated: "), error);
      assert.ok(error.includes("CURVED_AGENT_TOKEN"), error);
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "an unknown agent token yields not_authenticated",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    await seedAgentToken();

    const session = await connectMcp("crv_not_a_real_token");
    try {
      const error = await callError(session.client, "list_ready", {});
      assert.ok(error.startsWith("not_authenticated: "), error);
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "tool input validation rejects bad arguments as an error result",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();
    await seedIssue("validation target");

    const session = await connectMcp(token);
    try {
      await assertInputValidationError(
        session.client.callTool({
          name: "create_issue",
          arguments: { project: "TAC", title: "bad priority", priority: 5 },
        }),
      );
      await assertInputValidationError(
        session.client.callTool({
          name: "get_issue",
          arguments: { key: "tac" },
        }),
      );
      await assertInputValidationError(
        session.client.callTool({
          name: "comment",
          arguments: { key: "TAC-1", body: "" },
        }),
      );
    } finally {
      await closeMcp(session);
    }
  },
);

test(
  "successful payloads are pretty-printed JSON",
  { timeout: 30_000 },
  async () => {
    await seedProject();
    const token = await seedAgentToken();
    await seedIssue("pretty target");

    const session = await connectMcp(token);
    try {
      const result = await session.client.callTool({
        name: "get_issue",
        arguments: { key: "TAC-1" },
      });
      assert.notEqual(result.isError, true, textOf(result));
      const text = textOf(result);
      const parsed = JSON.parse(text) as TimelinePayload;
      assert.equal(parsed.issue.key, "TAC-1");
      assert.ok(text.includes('\n  "'), text);
    } finally {
      await closeMcp(session);
    }
  },
);
