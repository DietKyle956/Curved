#!/usr/bin/env node
// End-to-end acceptance gate for every non-browser entry point (LAS-155).
// Plain Node ESM: one throwaway database, one HTTP server, one check table.
//
// The gate never touches the default `curved` database's rows: it captures a
// per-table digest of them up front, runs every leg against
// `curved_acceptance_<pid>_<epoch>`, drops that database again, and fails when
// any default row changed. `--keep` skips the drop and prints the name.
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATABASE_URL = "postgres://curved:curved@127.0.0.1:55432/curved";
const ADMIN_DATABASE = "postgres";
const ACCEPTANCE_PREFIX = "curved_acceptance_";
/** Every table the schema owns; the gate must not write a single row of them. */
const GUARDED_TABLES = [
  "projects",
  "issues",
  "issue_events",
  "agents",
  "labels",
  "issue_labels",
  "issue_relations",
  "schema_migrations",
];
const PROJECT_KEY = "TAC";
const EXPECTED_MCP_TOOLS = [
  "claim_next",
  "comment",
  "create_issue",
  "get_issue",
  "list_ready",
  "mark_blocked",
  "release_claim",
  "submit_for_review",
];
const SERVER_READY_TIMEOUT_MS = 20_000;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const MCP_RESPONSE_TIMEOUT_MS = 20_000;
const MCP_EXIT_TIMEOUT_MS = 15_000;
const SSE_READY_TIMEOUT_MS = 5_000;
const SSE_CHANGE_TIMEOUT_MS = 1_000;
const STOP_GRACE_MS = 5_000;
const CHILD_TIMEOUT_MS = 60_000;

const USAGE = `Usage: node scripts/acceptance.mjs [--skip-browser] [--keep]

  --skip-browser  Skip the browser leg (scripts/acceptance-browser.mjs).
  --keep          Keep the throwaway database and print its name.

Legs: database, cli, mcp, server, http+sse, webhook, browser.
`;

/** One failed check; the scorer never swallows these. */
class AcceptanceFailure extends Error {
  constructor(leg, reason) {
    super(reason);
    this.name = "AcceptanceFailure";
    this.leg = leg;
  }
}

let checks = 0;
/** Children still alive, with whether they lead their own process group. */
const supervised = new Map();

function log(line) {
  process.stdout.write(`${line}\n`);
}

function pass(leg, detail) {
  log(`PASS ${leg}: ${detail}`);
}

function assert(leg, condition, reason) {
  if (!condition) {
    throw new AcceptanceFailure(leg, reason);
  }
  checks += 1;
}

function truncate(text, limit = 600) {
  const flat = text.trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`;
}

function describe(result) {
  const parts = [];
  if (result.timedOut) {
    parts.push("timed out");
  }
  if (result.stdout.trim() !== "") {
    parts.push(`stdout ${JSON.stringify(truncate(result.stdout))}`);
  }
  if (result.stderr.trim() !== "") {
    parts.push(`stderr ${JSON.stringify(truncate(result.stderr))}`);
  }
  return parts.length === 0 ? "no output" : parts.join("; ");
}

function delay(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    // A losing race timer must never keep the process alive after a green run.
    timer.unref();
  });
}

function supervise(child, detached) {
  supervised.set(child, detached);
  child.once("close", () => supervised.delete(child));
  return child;
}

function signalChild(child, detached, signal) {
  if (detached && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process is already gone.
  }
}

async function stopChild(child, detached) {
  const running = child.exitCode === null && child.signalCode === null;
  if (!running) {
    if (detached) {
      // The leader is gone, but a process-group member may still be alive.
      signalChild(child, true, "SIGTERM");
    }
    return;
  }
  const closed = new Promise((done) => child.once("close", done));
  signalChild(child, detached, "SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    delay(STOP_GRACE_MS).then(() => false),
  ]);
  if (!stopped) {
    signalChild(child, detached, "SIGKILL");
    await Promise.race([closed, delay(STOP_GRACE_MS)]);
  }
}

function withTimeout(promise, timeoutMs, leg, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(
        new AcceptanceFailure(leg, `${label} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function parseArgs(argv) {
  const options = { skipBrowser: false, keep: false };
  for (const arg of argv) {
    if (arg === "--skip-browser") {
      options.skipBrowser = true;
      continue;
    }
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    process.stderr.write(
      `acceptance: unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`,
    );
    process.exit(2);
  }
  return options;
}

/** Reads a single key out of the repo `.env`, mimicking `loadConfig`. */
function envFileValue(key) {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) {
    return undefined;
  }
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (line.slice(0, separator).trim() !== key) {
      continue;
    }
    const value = line.slice(separator + 1).trim();
    return value.replace(/^["']/, "").replace(/["']$/, "");
  }
  return undefined;
}

function defaultDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const fromFile = envFileValue("DATABASE_URL");
  return fromFile !== undefined && fromFile !== "" ? fromFile : DEFAULT_DATABASE_URL;
}

function urlWithDatabase(databaseUrl, name) {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function isMissingTable(error) {
  return error?.code === "42P01";
}

/**
 * Per-table digests (`count(*)` plus md5 of the ordered row text) of the
 * tables the gate promises not to touch. A table that does not exist yet is
 * reported as absent instead of silently skipped: a delete plus an insert
 * keeps `count(*)` equal, the digest does not.
 */
async function captureDigests(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tables = {};
    const absent = [];
    for (const table of GUARDED_TABLES) {
      try {
        const result = await client.query(
          `select count(*)::int as rows,
                  coalesce(md5(string_agg(entry.row_text, E'\\n' order by entry.row_text)), '') as digest
             from (select row_value::text as row_text
                     from ${quoteIdentifier(table)} row_value) entry`,
        );
        const row = result.rows[0];
        tables[table] = { rows: row.rows, digest: row.digest };
      } catch (error) {
        if (isMissingTable(error)) {
          absent.push(table);
          continue;
        }
        throw error;
      }
    }
    return { tables, absent };
  } finally {
    await client.end();
  }
}

function diffDigests(before, after) {
  const changed = [];
  const names = new Set([
    ...Object.keys(before.tables),
    ...Object.keys(after.tables),
  ]);
  for (const table of names) {
    const was = before.tables[table];
    const now = after.tables[table];
    if (was === undefined && now === undefined) {
      continue;
    }
    if (was === undefined || now === undefined) {
      changed.push(`${table} ${was === undefined ? "appeared" : "vanished"}`);
      continue;
    }
    if (was.rows !== now.rows || was.digest !== now.digest) {
      changed.push(
        `${table} ${was.rows} rows/${was.digest.slice(0, 12)} -> ${now.rows} rows/${now.digest.slice(0, 12)}`,
      );
    }
  }
  return changed;
}

async function createDatabase(adminUrl, name) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query(
      "select 1 from pg_database where datname = $1",
      [name],
    );
    if (existing.rowCount > 0) {
      await client.query(
        `drop database if exists ${quoteIdentifier(name)} with (force)`,
      );
    }
    await client.query(`create database ${quoteIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminUrl, name) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(
      `drop database if exists ${quoteIdentifier(name)} with (force)`,
    );
  } finally {
    await client.end();
  }
}

/** Runs a command to completion, capturing stdout and stderr. */
function execCapture(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supervise(child, false);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      signalChild(child, false, "SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.echo) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.echo) {
        process.stderr.write(chunk);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function runCli(databaseUrl, args, token) {
  return execCapture(process.execPath, ["src/composition/cli.ts", ...args], {
    env: {
      DATABASE_URL: databaseUrl,
      CURVED_AGENT_TOKEN: token ?? "",
    },
    timeoutMs: CHILD_TIMEOUT_MS,
    echo: true,
  });
}

function expectStdout(leg, result, command, expected) {
  assert(leg, result.code === 0, `${command} exited ${result.code}: ${describe(result)}`);
  assert(
    leg,
    result.stdout === expected,
    `${command} printed ${JSON.stringify(result.stdout)}, expected ${JSON.stringify(expected)}`,
  );
}

function expectFailure(leg, result, command, code, stderrPrefix) {
  assert(
    leg,
    result.code === code,
    `${command} exited ${result.code}, expected ${code}: ${describe(result)}`,
  );
  assert(
    leg,
    result.stderr.startsWith(stderrPrefix),
    `${command} stderr was ${JSON.stringify(truncate(result.stderr))}, expected it to start with ${JSON.stringify(stderrPrefix)}`,
  );
}

/** Splits `ready` output into its issue rows and its `busy:` line. */
function readReady(leg, result) {
  assert(leg, result.code === 0, `ready exited ${result.code}: ${describe(result)}`);
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  const busyLine = lines.find((line) => line.startsWith("busy: "));
  assert(
    leg,
    busyLine !== undefined,
    `ready printed no busy line: ${JSON.stringify(result.stdout)}`,
  );
  const rows = lines.filter((line) => line !== busyLine);
  return { rows, busy: busyLine.slice("busy: ".length) };
}

async function cliLeg(databaseUrl) {
  const leg = "cli";

  expectStdout(
    leg,
    await runCli(databaseUrl, ["project", "add", PROJECT_KEY, "Acceptance"]),
    "project add",
    `created project ${PROJECT_KEY} (Acceptance)\n`,
  );

  const agent = await runCli(databaseUrl, ["agent", "add", "alpha"]);
  assert(leg, agent.code === 0, `agent add exited ${agent.code}: ${describe(agent)}`);
  assert(
    leg,
    agent.stdout.startsWith("created agent alpha\n"),
    `agent add printed ${JSON.stringify(agent.stdout)}`,
  );
  const tokenMatch = /^token: (crv_\S+)$/m.exec(agent.stdout);
  assert(
    leg,
    tokenMatch !== null,
    `agent add printed no token: ${JSON.stringify(agent.stdout)}`,
  );
  const alphaToken = tokenMatch[1];

  expectStdout(
    leg,
    await runCli(databaseUrl, [
      "issue",
      "add",
      PROJECT_KEY,
      "Acceptance CLI task",
      "--status",
      "todo",
    ]),
    "issue add",
    `created issue ${PROJECT_KEY}-1 (Acceptance CLI task)\n`,
  );

  const ready = readReady(leg, await runCli(databaseUrl, ["ready"], alphaToken));
  assert(
    leg,
    ready.rows.length === 1 && ready.rows[0].startsWith(`${PROJECT_KEY}-1\t`),
    `ready rows were ${JSON.stringify(ready.rows)}`,
  );
  assert(leg, ready.busy === "-", `ready busy line was ${JSON.stringify(ready.busy)}`);

  expectStdout(
    leg,
    await runCli(databaseUrl, ["claim"], alphaToken),
    "claim",
    `claimed ${PROJECT_KEY}-1\n`,
  );

  expectFailure(
    leg,
    await runCli(databaseUrl, ["claim"], alphaToken),
    "second claim",
    1,
    `agent_busy: agent "alpha" already holds issue "${PROJECT_KEY}-1"`,
  );

  expectStdout(
    leg,
    await runCli(databaseUrl, ["review", `${PROJECT_KEY}-1`, "done"], alphaToken),
    "review",
    `submitted ${PROJECT_KEY}-1 for review\n`,
  );

  const reviewing = readReady(
    leg,
    await runCli(databaseUrl, ["ready"], alphaToken),
  );
  assert(
    leg,
    reviewing.rows.length === 0,
    `ready while in review still listed ${JSON.stringify(reviewing.rows)}`,
  );
  assert(
    leg,
    reviewing.busy === `${PROJECT_KEY}-1`,
    `ready while in review printed busy ${JSON.stringify(reviewing.busy)}`,
  );

  expectFailure(
    leg,
    await runCli(databaseUrl, ["claim"], alphaToken),
    "claim while in review",
    1,
    "agent_busy:",
  );

  expectStdout(
    leg,
    await runCli(databaseUrl, [`issue`, `move`, `${PROJECT_KEY}-1`, "done"]),
    "issue move",
    `moved ${PROJECT_KEY}-1 to done\n`,
  );

  const done = readReady(leg, await runCli(databaseUrl, ["ready"], alphaToken));
  assert(leg, done.rows.length === 0, `ready after done listed ${JSON.stringify(done.rows)}`);
  assert(leg, done.busy === "-", `ready after done printed busy ${JSON.stringify(done.busy)}`);

  expectFailure(
    leg,
    await runCli(databaseUrl, ["claim"], alphaToken),
    "claim with nothing ready",
    1,
    "no_ready_issue:",
  );

  return alphaToken;
}

async function mcpLeg(databaseUrl, alphaToken) {
  const leg = "mcp";
  const child = supervise(
    spawn(process.execPath, ["src/composition/mcp.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CURVED_AGENT_TOKEN: alphaToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }),
    false,
  );

  const messages = [];
  const invalid = [];
  let stderr = "";
  let buffered = "";
  let toolsFound = null;
  const toolsListed = Promise.withResolvers();

  function handleLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      invalid.push(line);
      return;
    }
    messages.push(parsed);
    if (parsed !== null && typeof parsed === "object" && parsed.id === 2) {
      toolsFound = parsed;
      toolsListed.resolve();
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf("\n")) !== -1) {
      handleLine(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderr += chunk;
    if (stderr.length > 20_000) {
      stderr = stderr.slice(-20_000);
    }
  });
  const closed = new Promise((done) => {
    child.once("close", (code, signal) => {
      if (toolsFound === null) {
        toolsListed.reject(
          new AcceptanceFailure(
            leg,
            `mcp exited before answering tools/list (code ${code}, signal ${signal})`,
          ),
        );
      }
      done({ code, signal });
    });
    child.once("error", (error) => {
      if (toolsFound === null) {
        toolsListed.reject(
          new AcceptanceFailure(leg, `could not start mcp: ${error.message}`),
        );
      }
      done({ code: null, signal: null, error });
    });
  });
  child.stdin.on("error", () => {
    // The server may close stdin first; the exit code is what matters.
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "curved-acceptance", version: "0.0.0" },
      },
    })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );

  try {
    await withTimeout(toolsListed.promise, MCP_RESPONSE_TIMEOUT_MS, leg, "tools/list response");
  } catch (error) {
    throw new AcceptanceFailure(
      leg,
      `${error.message}${stderr.trim() === "" ? "" : ` (stderr: ${truncate(stderr)})`}`,
    );
  }

  assert(
    leg,
    messages.length > 0 && invalid.length === 0,
    `stdout had ${invalid.length} non-JSON line(s): ${JSON.stringify(truncate(invalid.join(" | ")))}`,
  );
  const notJsonRpc = messages.filter(
    (message) => message === null || typeof message !== "object" || message.jsonrpc !== "2.0",
  );
  assert(
    leg,
    notJsonRpc.length === 0,
    `${notJsonRpc.length} message(s) were not JSON-RPC 2.0: ${JSON.stringify(truncate(JSON.stringify(notJsonRpc)))}`,
  );
  const tools = toolsFound?.result?.tools;
  assert(leg, Array.isArray(tools), `tools/list returned ${JSON.stringify(truncate(JSON.stringify(toolsFound)))}`);
  const names = tools.map((tool) => tool?.name);
  assert(
    leg,
    JSON.stringify(names.slice().sort()) === JSON.stringify(EXPECTED_MCP_TOOLS.slice().sort()),
    `tools/list names were ${JSON.stringify(names)}`,
  );

  child.stdin.end();
  let exit;
  try {
    exit = await withTimeout(closed, MCP_EXIT_TIMEOUT_MS, leg, "mcp stdio exit");
  } catch (error) {
    throw new AcceptanceFailure(
      leg,
      `${error.message}${stderr.trim() === "" ? "" : ` (stderr: ${truncate(stderr)})`}`,
    );
  }
  assert(
    leg,
    exit.code === 0,
    `mcp exited ${exit.code}${exit.signal === null ? "" : ` (signal ${exit.signal})`}${stderr.trim() === "" ? "" : `: ${truncate(stderr)}`}`,
  );
}

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  if (port === 0) {
    throw new Error("could not reserve a free port");
  }
  return port;
}

async function startServer(databaseUrl) {
  const leg = "server";
  const port = await findFreePort();
  const uiToken = `ui_${randomBytes(18).toString("base64url")}`;
  const webhookSecret = `whsec_${randomBytes(18).toString("base64url")}`;
  const child = supervise(
    spawn("npm", ["start"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        CURVED_UI_TOKEN: uiToken,
        GITHUB_WEBHOOK_SECRET: webhookSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }),
    true,
  );

  let stdout = "";
  let stderr = "";
  const readyLine = `curved listening on http://127.0.0.1:${port}`;
  const ready = Promise.withResolvers();
  const timer = setTimeout(() => {
    ready.reject(
      new AcceptanceFailure(
        leg,
        `server did not print "${readyLine}" within ${SERVER_READY_TIMEOUT_MS}ms${stderr.trim() === "" ? "" : ` (stderr: ${truncate(stderr)})`}`,
      ),
    );
  }, SERVER_READY_TIMEOUT_MS);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes(readyLine)) {
      clearTimeout(timer);
      ready.resolve();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderr += chunk;
    if (stderr.length > 20_000) {
      stderr = stderr.slice(-20_000);
    }
  });
  child.once("error", (error) => {
    clearTimeout(timer);
    ready.reject(
      new AcceptanceFailure(leg, `could not start npm: ${error.message}`),
    );
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    ready.reject(
      new AcceptanceFailure(
        leg,
        `server exited before it listened (code ${code}, signal ${signal})${stderr.trim() === "" ? "" : `: ${truncate(stderr)}`}`,
      ),
    );
  });

  await ready.promise;
  return {
    uiToken,
    webhookSecret,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

function parseSseFrame(raw, at) {
  let event = "message";
  const data = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice("event: ".length).trim();
    } else if (line.startsWith("data: ")) {
      data.push(line.slice("data: ".length));
    }
  }
  return { event, data: data.join("\n"), at };
}

function settleFrameWaiters(state) {
  for (const waiter of [...state.waiters]) {
    const match = state.frames.find(waiter.predicate);
    if (match === undefined) {
      continue;
    }
    state.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(match);
  }
}

async function openSseStream(url, headers, leg) {
  const controller = new AbortController();
  // Only the connect (response headers) gets a deadline: the body is the
  // long-lived event stream, whose reads are bounded by the frame waits.
  let connectTimedOut = false;
  const connectTimer = setTimeout(() => {
    connectTimedOut = true;
    controller.abort();
  }, HTTP_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    if (connectTimedOut) {
      throw new AcceptanceFailure(
        leg,
        `SSE connect to ${url} timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(connectTimer);
  }
  const state = {
    response,
    controller,
    frames: [],
    failure: null,
    waiters: new Set(),
    reader: response.body.getReader(),
    loop: null,
  };
  const decoder = new TextDecoder();
  let buffered = "";
  state.loop = (async () => {
    try {
      while (true) {
        const { value, done } = await state.reader.read();
        if (done) {
          break;
        }
        buffered += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffered.indexOf("\n\n")) !== -1) {
          const raw = buffered.slice(0, index);
          buffered = buffered.slice(index + 2);
          state.frames.push(parseSseFrame(raw, performance.now()));
          settleFrameWaiters(state);
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        state.failure = error;
      }
    }
  })();
  return state;
}

function waitForFrame(state, predicate, leg, label, budget) {
  const existing = state.frames.find(predicate);
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const remainingMs = Math.max(0, budget.deadlineAt - performance.now());
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      rejectPromise(
        new AcceptanceFailure(leg, `${label} did not arrive within ${budget.timeoutMs}ms`),
      );
    }, remainingMs);
    const waiter = {
      predicate,
      timer,
      resolve: (match) => resolvePromise(match),
    };
    state.waiters.add(waiter);
  });
}

async function closeSseStream(state) {
  state.controller.abort();
  try {
    await state.reader.cancel();
  } catch {
    // The stream is already torn down by the abort.
  }
  await state.loop.catch(() => {});
}

async function httpLeg(server, databaseUrl) {
  const leg = "http+sse";
  const { baseUrl, uiToken } = server;
  const bearer = { authorization: `Bearer ${uiToken}` };

  const me = await fetch(`${baseUrl}/api/me`, {
    headers: bearer,
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  assert(leg, me.status === 200, `GET /api/me returned ${me.status}`);
  const meBody = await me.json();
  assert(
    leg,
    meBody?.actor?.type === "human",
    `GET /api/me actor was ${JSON.stringify(meBody)}`,
  );

  const session = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: uiToken }),
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  assert(leg, session.status === 200, `POST /api/session returned ${session.status}`);
  const sessionBody = await session.json();
  assert(
    leg,
    sessionBody?.actor?.type === "human",
    `POST /api/session actor was ${JSON.stringify(sessionBody)}`,
  );
  const setCookie = session.headers.get("set-cookie");
  assert(
    leg,
    typeof setCookie === "string" && setCookie.startsWith("curved_session="),
    `POST /api/session set-cookie was ${JSON.stringify(setCookie)}`,
  );
  const cookiePair = setCookie.split(";")[0].trim();
  const expectedCookie = `curved_session=${createHash("sha256").update(uiToken).digest("hex")}`;
  assert(
    leg,
    cookiePair === expectedCookie,
    `session cookie was ${cookiePair}, expected ${expectedCookie}`,
  );

  const stream = await openSseStream(`${baseUrl}/api/events`, { cookie: cookiePair }, leg);
  assert(leg, stream.response.status === 200, `GET /api/events returned ${stream.response.status}`);
  await waitForFrame(stream, (frame) => frame.event === "ready", leg, "SSE ready frame", {
    deadlineAt: performance.now() + SSE_READY_TIMEOUT_MS,
    timeoutMs: SSE_READY_TIMEOUT_MS,
  });
  assert(
    leg,
    stream.frames[0]?.event === "ready",
    `first SSE frame was ${JSON.stringify(stream.frames[0] ?? null)}`,
  );

  const issuesResponse = await fetch(`${baseUrl}/api/issues?project=${PROJECT_KEY}`, {
    headers: bearer,
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  assert(
    leg,
    issuesResponse.status === 200,
    `GET /api/issues?project=${PROJECT_KEY} returned ${issuesResponse.status}`,
  );
  const issuesBody = await issuesResponse.json();
  assert(
    leg,
    Array.isArray(issuesBody.issues) && issuesBody.issues.length > 0,
    `GET /api/issues?project=${PROJECT_KEY} returned ${JSON.stringify(truncate(JSON.stringify(issuesBody)))}`,
  );
  const projectId = issuesBody.issues[0].projectId;
  assert(leg, Number.isInteger(projectId), `project id was ${JSON.stringify(projectId)}`);

  const commentStartedAt = performance.now();
  const comment = await runCli(databaseUrl, [
    "issue",
    "comment",
    `${PROJECT_KEY}-1`,
    "acceptance sse check",
  ]);
  assert(leg, comment.code === 0, `issue comment exited ${comment.code}: ${describe(comment)}`);
  const commentFinishedAt = performance.now();
  await waitForFrame(
    stream,
    (frame) =>
      frame.event === "issues_changed" &&
      frame.data.trim() === String(projectId) &&
      frame.at >= commentStartedAt,
    leg,
    `issues_changed(${projectId}) after the comment`,
    {
      deadlineAt: commentFinishedAt + SSE_CHANGE_TIMEOUT_MS,
      timeoutMs: SSE_CHANGE_TIMEOUT_MS,
    },
  );

  const page = await fetch(`${baseUrl}/p/${PROJECT_KEY}`, {
    headers: bearer,
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  assert(leg, page.status === 200, `GET /p/${PROJECT_KEY} returned ${page.status}`);
  const pageType = page.headers.get("content-type") ?? "";
  assert(
    leg,
    pageType.startsWith("text/html"),
    `GET /p/${PROJECT_KEY} content-type was ${JSON.stringify(pageType)}`,
  );
  const html = await page.text();
  assert(
    leg,
    html.includes('id="root"'),
    `GET /p/${PROJECT_KEY} did not serve the SPA shell`,
  );

  const streamFailure = stream.failure;
  await closeSseStream(stream);
  assert(
    leg,
    streamFailure === null,
    `SSE stream failed: ${streamFailure instanceof Error ? streamFailure.message : String(streamFailure)}`,
  );
}

async function issueDetail(baseUrl, headers, key) {
  const response = await fetch(`${baseUrl}/api/issues/${key}`, {
    headers,
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.json() };
}

async function webhookLeg(server, databaseUrl) {
  const leg = "webhook";
  const { baseUrl, uiToken, webhookSecret } = server;
  const bearer = { authorization: `Bearer ${uiToken}` };

  const agent = await runCli(databaseUrl, ["agent", "add", "beta"]);
  assert(leg, agent.code === 0, `agent add beta exited ${agent.code}: ${describe(agent)}`);
  const tokenMatch = /^token: (crv_\S+)$/m.exec(agent.stdout);
  assert(leg, tokenMatch !== null, `agent add beta printed no token: ${JSON.stringify(agent.stdout)}`);
  const betaToken = tokenMatch[1];

  expectStdout(
    leg,
    await runCli(databaseUrl, [
      "issue",
      "add",
      PROJECT_KEY,
      "Webhook task",
      "--status",
      "todo",
    ]),
    "issue add webhook",
    `created issue ${PROJECT_KEY}-2 (Webhook task)\n`,
  );

  expectStdout(
    leg,
    await runCli(databaseUrl, ["claim", PROJECT_KEY], betaToken),
    "claim as beta",
    `claimed ${PROJECT_KEY}-2\n`,
  );

  const payload = {
    action: "opened",
    number: 7,
    pull_request: {
      number: 7,
      title: `${PROJECT_KEY}-2 acceptance`,
      merged: false,
      head: { ref: `${PROJECT_KEY}-2-acceptance` },
    },
  };
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const deliver = () =>
    fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
    });

  const first = await deliver();
  const firstText = await first.text();
  assert(leg, first.status === 200, `delivery returned ${first.status}: ${truncate(firstText)}`);
  assert(
    leg,
    firstText === '{"ok":true}',
    `delivery body was ${JSON.stringify(truncate(firstText))}`,
  );

  const detail = await issueDetail(baseUrl, bearer, `${PROJECT_KEY}-2`);
  assert(leg, detail.status === 200, `GET /api/issues/${PROJECT_KEY}-2 returned ${detail.status}`);
  assert(
    leg,
    detail.body?.issue?.status === "in_review",
    `issue status was ${JSON.stringify(detail.body?.issue?.status)}`,
  );
  assert(
    leg,
    detail.body?.issue?.claimedBy === "beta",
    `issue claimedBy was ${JSON.stringify(detail.body?.issue?.claimedBy)}, expected the claim to survive the move as "beta"`,
  );
  const gitEvents = (detail.body?.events ?? []).filter((event) => event?.actorType === "git");
  assert(
    leg,
    gitEvents.length === 1,
    `expected one git event, found ${gitEvents.length}`,
  );
  assert(
    leg,
    gitEvents[0].body === "pull request #7 opened",
    `git event body was ${JSON.stringify(gitEvents[0].body)}`,
  );

  const replay = await deliver();
  const replayText = await replay.text();
  assert(leg, replay.status === 200, `replay returned ${replay.status}: ${truncate(replayText)}`);
  assert(
    leg,
    replayText === '{"ok":true,"ignored":true}',
    `replay body was ${JSON.stringify(truncate(replayText))}`,
  );

  const after = await issueDetail(baseUrl, bearer, `${PROJECT_KEY}-2`);
  assert(leg, after.status === 200, `GET /api/issues/${PROJECT_KEY}-2 returned ${after.status}`);
  const replayedGit = (after.body?.events ?? []).filter((event) => event?.actorType === "git");
  assert(
    leg,
    replayedGit.length === 1,
    `replay left ${replayedGit.length} git events, expected 1`,
  );
  assert(
    leg,
    after.body?.issue?.status === "in_review",
    `replay moved the issue to ${JSON.stringify(after.body?.issue?.status)}`,
  );
}

async function browserLeg(server, databaseUrl) {
  const leg = "browser";
  // Detached so the leg leads its own process group: chromium inherits that
  // group, so one group signal on shutdown reaches the browser too.
  const child = supervise(
    spawn(process.execPath, ["scripts/acceptance-browser.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ACCEPTANCE_BASE_URL: server.baseUrl,
        ACCEPTANCE_UI_TOKEN: server.uiToken,
        ACCEPTANCE_PROJECT_KEY: PROJECT_KEY,
      },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    }),
    true,
  );
  const exited = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const result = await exited;
  assert(
    leg,
    result.code === 0,
    `scripts/acceptance-browser.mjs exited ${result.code}${result.signal === null ? "" : ` (signal ${result.signal})`}`,
  );
}

function normalizeFailure(error, leg) {
  if (error instanceof AcceptanceFailure) {
    return { leg: error.leg, reason: error.message };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return { leg, reason };
}

/** Everything shutdown needs; filled in by `main` as the gate progresses. */
const gate = {
  currentLeg: "setup",
  keep: false,
  defaultUrl: null,
  adminUrl: null,
  databaseName: null,
  databaseCreated: false,
  before: null,
};

let shuttingDown = false;
let shutdownPromise = null;

/**
 * Drops the throwaway database unless `--keep` asked to keep it. The
 * `databaseCreated` flag flips synchronously, so a signal path and `main`'s
 * `finally` can never drop the same database twice.
 */
async function dropThrowawayDatabase() {
  if (!gate.databaseCreated) {
    return null;
  }
  gate.databaseCreated = false;
  if (gate.keep) {
    log(`acceptance: kept database ${gate.databaseName}`);
    return null;
  }
  try {
    await dropDatabase(gate.adminUrl, gate.databaseName);
    return null;
  } catch (error) {
    return `dropping ${gate.databaseName} failed: ${normalizeFailure(error, gate.currentLeg).reason}`;
  }
}

/**
 * Stops every supervised child, drops the throwaway database, then re-digests
 * the default database. Children stop newest-first, so the browser leg (and
 * chromium with it) dies before the server and long before the database is
 * dropped. Idempotent: the first caller does the work, later callers await the
 * same promise. `main`'s `finally` and the signal handlers both call this.
 */
function shutdown() {
  if (shuttingDown && shutdownPromise !== null) {
    return shutdownPromise;
  }
  shuttingDown = true;
  shutdownPromise = (async () => {
    const cleanupProblems = [];
    for (const [child, detached] of [...supervised.entries()].reverse()) {
      try {
        await stopChild(child, detached);
      } catch (error) {
        cleanupProblems.push(
          `stopping a child process failed: ${normalizeFailure(error, gate.currentLeg).reason}`,
        );
      }
    }

    const dropProblem = await dropThrowawayDatabase();
    if (dropProblem !== null) {
      cleanupProblems.push(dropProblem);
    }

    if (gate.defaultUrl !== null) {
      let after = null;
      try {
        after = await captureDigests(gate.defaultUrl);
      } catch (error) {
        cleanupProblems.push(
          `re-reading the default database digests failed: ${normalizeFailure(error, gate.currentLeg).reason}`,
        );
      }
      if (gate.before !== null && after !== null) {
        const changed = diffDigests(gate.before, after);
        if (changed.length > 0) {
          cleanupProblems.push(`default database rows changed: ${changed.join(", ")}`);
        }
      }
    }

    for (const problem of cleanupProblems) {
      log(`FAIL cleanup: ${problem}`);
    }
    if (cleanupProblems.length > 0) {
      process.exitCode = 1;
    }
  })();
  return shutdownPromise;
}

/**
 * Node exits on SIGINT/SIGTERM without unwinding `finally`, and the server
 * leads its own process group, so the signal path must clean up explicitly:
 * otherwise a detached server, an undropped database, and a temp chromium
 * profile survive the interrupted gate.
 */
async function handleSignal(signal) {
  process.stderr.write(
    `acceptance: received ${signal}, stopping children and cleaning up\n`,
  );
  try {
    await shutdown();
  } catch (error) {
    process.stderr.write(
      `acceptance: cleanup after ${signal} failed: ${normalizeFailure(error, gate.currentLeg).reason}\n`,
    );
  }
  process.exit(1);
}

process.once("SIGINT", () => {
  void handleSignal("SIGINT");
});
process.once("SIGTERM", () => {
  void handleSignal("SIGTERM");
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const defaultUrl = defaultDatabaseUrl();
  const databaseName = `${ACCEPTANCE_PREFIX}${process.pid}_${Math.floor(Date.now() / 1000)}`;
  if (!databaseName.startsWith(ACCEPTANCE_PREFIX)) {
    process.stderr.write(`acceptance: refusing database name ${JSON.stringify(databaseName)}\n`);
    process.exit(2);
  }
  const acceptanceUrl = urlWithDatabase(defaultUrl, databaseName);
  const adminUrl = urlWithDatabase(defaultUrl, ADMIN_DATABASE);
  gate.keep = options.keep;
  gate.defaultUrl = defaultUrl;
  gate.adminUrl = adminUrl;
  gate.databaseName = databaseName;

  let failure = null;

  try {
    gate.currentLeg = "database";
    gate.before = await captureDigests(defaultUrl);
    for (const table of gate.before.absent) {
      log(`acceptance: default database has no ${table} table yet, skipping its guard`);
    }
    log(`acceptance: throwaway database ${databaseName}`);
    await createDatabase(adminUrl, databaseName);
    gate.databaseCreated = true;
    if (shuttingDown) {
      // A signal landed while the database was being created and the signal
      // path may already have passed its drop step; drop it here so an
      // interrupted run cannot leave a throwaway database behind.
      const dropProblem = await dropThrowawayDatabase();
      if (dropProblem !== null) {
        log(`FAIL cleanup: ${dropProblem}`);
        process.exitCode = 1;
      }
      throw new AcceptanceFailure(
        "database",
        "interrupted by a signal while preparing the throwaway database",
      );
    }
    const migrated = await execCapture(
      process.execPath,
      ["src/composition/migrate.ts"],
      {
        env: { DATABASE_URL: acceptanceUrl },
        timeoutMs: 120_000,
        echo: true,
      },
    );
    assert(
      "database",
      migrated.code === 0,
      `migrate exited ${migrated.code}: ${describe(migrated)}`,
    );
    pass("database", `created and migrated ${databaseName}`);

    gate.currentLeg = "cli";
    let legChecks = checks;
    const alphaToken = await cliLeg(acceptanceUrl);
    pass("cli", `${checks - legChecks} checks: queue lifecycle, busy lines, exit codes`);

    gate.currentLeg = "mcp";
    legChecks = checks;
    await mcpLeg(acceptanceUrl, alphaToken);
    pass("mcp", `${checks - legChecks} checks: ${EXPECTED_MCP_TOOLS.length} tools over NDJSON stdio`);

    gate.currentLeg = "server";
    legChecks = checks;
    const server = await startServer(acceptanceUrl);
    pass("server", `listening on ${server.baseUrl}`);

    gate.currentLeg = "http+sse";
    legChecks = checks;
    await httpLeg(server, acceptanceUrl);
    pass(
      "http+sse",
      `${checks - legChecks} checks: bearer, session cookie, ready frame, issues_changed for ${PROJECT_KEY}`,
    );

    gate.currentLeg = "webhook";
    legChecks = checks;
    await webhookLeg(server, acceptanceUrl);
    pass("webhook", `${checks - legChecks} checks: opened moved ${PROJECT_KEY}-2 to in_review, replay ignored`);

    if (!options.skipBrowser) {
      gate.currentLeg = "browser";
      legChecks = checks;
      await browserLeg(server, acceptanceUrl);
      pass("browser", `${checks - legChecks} checks: scripts/acceptance-browser.mjs exited 0`);
    }
  } catch (error) {
    failure = normalizeFailure(error, gate.currentLeg);
  } finally {
    await shutdown();
  }

  if (failure !== null) {
    log(`FAIL ${failure.leg}: ${failure.reason}`);
    process.exitCode = 1;
  }
  if (process.exitCode === 1) {
    return;
  }
  log(`acceptance: ok (${checks} checks)`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `acceptance: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
