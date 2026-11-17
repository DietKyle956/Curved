#!/usr/bin/env node
// Browser leg of the LAS-155 acceptance gate.
//
// A dependency-free Chromium driver over the DevTools Protocol. It signs in,
// exercises the mobile board (status tabs, command palette, new issue dialog),
// then checks that a comment posted in one tab reaches a second tab over the
// realtime channel without a reload.
//
// Environment (set by scripts/acceptance.mjs):
//   ACCEPTANCE_BASE_URL     e.g. http://127.0.0.1:12345
//   ACCEPTANCE_UI_TOKEN     UI token used to sign in
//   ACCEPTANCE_PROJECT_KEY  existing project key, e.g. TAC
//
// Exit 0 prints PASS browser: lines. Exit 1 prints FAIL browser: with the last
// phase plus diagnostic page text.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const METRICS = {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
};

// Evidence is run-scoped: concurrent acceptance runs must never overwrite each
// other's screenshots, and a PASS line must never report the byte count of a
// file some other run wrote.
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const SCREENSHOT_BOARD = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-board.png`,
);
const SCREENSHOT_DETAIL = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-detail.png`,
);
const SCREENSHOT_SECOND_TAB = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-second-tab.png`,
);

const CHROMIUM_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
];
const HARD_TIMEOUT_MS = 120_000;
const COMMENT_LATENCY_LIMIT_MS = 1100;

const HELPER_METHODS = [
  "waitFor",
  "setValue",
  "click",
  "text",
  "count",
  "bodyText",
];

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"];

const SIGNIN_TOKEN = '[data-testid="signin-token"]';
const SIGNIN_SUBMIT = '[data-testid="signin-submit"]';
const STATUS_TAB = '[data-testid^="status-tab-"]';
const PALETTE = '[role="dialog"][aria-label="Command palette"]';
const PALETTE_INPUT = 'input[role="combobox"]';
const NEW_ISSUE_TITLE = '[data-testid="new-issue-title"]';
const NEW_ISSUE_SUBMIT = '[data-testid="new-issue-submit"]';
const ISSUE_DETAIL = '[data-testid="issue-detail"]';
const TIMELINE_EVENT = '[data-testid="timeline-event"]';
const COMMENT_INPUT = "#issue-comment";
const COMMENT_SUBMIT = '[data-testid="comment-submit"]';

const ENTER_KEY = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  modifiers: 0,
  text: "\r",
};

const CTRL_K = {
  key: "k",
  code: "KeyK",
  windowsVirtualKeyCode: 75,
  modifiers: 2,
};

const state = {
  phase: "startup",
  chromePath: null,
  chrome: null,
  chromeStderr: "",
  cdp: null,
  tabs: [],
  tmpDir: null,
  consoleLines: [],
  finished: false,
  cleanedUp: false,
};

let watchdog = null;

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function out(line) {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, resolve);
  });
}

function errOut(line) {
  return new Promise((resolve) => {
    process.stderr.write(`${line}\n`, resolve);
  });
}

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function describeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatException(details) {
  const description =
    details.exception?.description ?? details.text ?? "runtime exception";
  return String(description).split("\n")[0];
}

// A document created after the helpers were injected (a real navigation, a
// redirect) has no `window.__acc`, so `window.__acc.waitFor(...)` fails with
// `TypeError: Cannot read properties of undefined (reading 'waitFor')`. That
// message never names `__acc`, so both shapes have to be recognised here or the
// re-injection below can never fire after a navigation.
function isMissingHelperError(message) {
  if (message.includes("__acc")) {
    return true;
  }
  const missing =
    /Cannot read propert(?:y|ies) of undefined \(reading '([^']+)'\)/.exec(
      message,
    );
  return missing !== null && HELPER_METHODS.includes(missing[1]);
}

/* -------------------------------------------------------------------------- */
/* CDP client                                                                 */
/* -------------------------------------------------------------------------- */

class Cdp {
  #socket;
  #pending = new Map();
  #waiters = new Set();
  #listeners = new Set();
  #nextId = 0;
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    this.#socket.addEventListener("message", (event) => {
      this.#receive(event);
    });
    this.#socket.addEventListener("close", () => {
      this.#closed = true;
      const problem = new Error("CDP socket closed");
      for (const entry of this.#pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(problem);
      }
      this.#pending.clear();
      for (const waiter of [...this.#waiters]) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.reject(problem);
      }
    });
  }

  static async connect(url, timeoutMs = 15_000) {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`timed out connecting to CDP websocket after ${timeoutMs}ms`),
        );
        try {
          socket.close();
        } catch {
          // Ignore: already closing.
        }
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP websocket failed to connect"));
        },
        { once: true },
      );
    });
    return new Cdp(socket);
  }

  onEvent(handler) {
    this.#listeners.add(handler);
    return () => {
      this.#listeners.delete(handler);
    };
  }

  #receive(event) {
    const data = event.data;
    let text = null;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
        "utf8",
      );
    }
    if (text === null) {
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const entry = this.#pending.get(message.id);
      if (entry === undefined) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        const detail = message.error.message ?? JSON.stringify(message.error);
        entry.reject(new Error(`${entry.method}: ${detail}`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    for (const waiter of [...this.#waiters]) {
      if (
        waiter.method === message.method &&
        waiter.sessionId === (message.sessionId ?? null)
      ) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(message.params ?? {});
      }
    }

    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch {
        // Diagnostic listeners must never break the protocol.
      }
    }
  }

  send(method, params = {}, sessionId = null) {
    if (this.#closed) {
      return Promise.reject(new Error(`CDP socket closed before ${method}`));
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer, method });
      const payload =
        sessionId === null
          ? { id, method, params }
          : { id, method, params, sessionId };
      try {
        this.#socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  onceEvent(method, sessionId = null, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        sessionId,
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      // Ignore: socket already closed.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* In-page helpers, injected once per document                                */
/* -------------------------------------------------------------------------- */

const HELPER_SOURCE = String.raw`
(() => {
  if (window.__acc !== undefined) {
    return true;
  }
  const pollMs = 50;

  function requireElement(selector) {
    const element = document.querySelector(selector);
    if (element === null) {
      throw new Error(
        "element not found: " +
          JSON.stringify(selector) +
          " at " +
          window.location.pathname,
      );
    }
    return element;
  }

  function pageExcerpt() {
    const body = document.body;
    if (body === null) {
      return "(no body)";
    }
    return String(body.innerText || "")
      .slice(0, 500)
      .replace(/\s+/g, " ")
      .trim();
  }

  function waitFor(selector, timeoutMs) {
    const limit = typeof timeoutMs === "number" ? timeoutMs : 10000;
    return new Promise((resolve, reject) => {
      const started = performance.now();
      function tick() {
        if (document.querySelector(selector) !== null) {
          resolve(true);
          return;
        }
        const elapsed = performance.now() - started;
        if (elapsed >= limit) {
          reject(
            new Error(
              "waitFor " +
                JSON.stringify(selector) +
                " timed out after " +
                Math.round(elapsed) +
                "ms at " +
                window.location.pathname +
                "; page text: " +
                pageExcerpt(),
            ),
          );
          return;
        }
        setTimeout(tick, pollMs);
      }
      tick();
    });
  }

  function setValue(selector, text) {
    const element = requireElement(selector);
    element.focus();
    let proto;
    if (element instanceof HTMLTextAreaElement) {
      proto = HTMLTextAreaElement.prototype;
    } else if (element instanceof HTMLInputElement) {
      proto = HTMLInputElement.prototype;
    } else {
      throw new Error(
        "setValue unsupported element for " + JSON.stringify(selector),
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor === undefined || descriptor.set === undefined) {
      throw new Error(
        "setValue: no native value setter for " + JSON.stringify(selector),
      );
    }
    descriptor.set.call(element, String(text));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  }

  function click(selector) {
    const element = requireElement(selector);
    element.click();
    return true;
  }

  function text(selector) {
    return String(requireElement(selector).textContent || "").trim();
  }

  function count(selector) {
    return document.querySelectorAll(selector).length;
  }

  function bodyText() {
    const body = document.body;
    if (body === null) {
      return "";
    }
    return String(body.innerText || "");
  }

  window.__acc = {
    waitFor: waitFor,
    setValue: setValue,
    click: click,
    text: text,
    count: count,
    bodyText: bodyText,
  };
  return true;
})()
`;

/* -------------------------------------------------------------------------- */
/* Tab wrapper                                                                */
/* -------------------------------------------------------------------------- */

class Tab {
  constructor(cdp, targetId, sessionId, label) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.label = label;
  }

  async evaluate(expression) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.cdp.send(
          "Runtime.evaluate",
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
          this.sessionId,
        );
        if (result.exceptionDetails !== undefined) {
          throw new Error(formatException(result.exceptionDetails));
        }
        return result.result?.value;
      } catch (error) {
        lastError = error;
        const message = describeError(error);
        const transient =
          /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|No frame for given/i.test(
            message,
          );
        if (!transient || attempt === 2) {
          throw error;
        }
        await sleep(150);
      }
    }
    throw lastError;
  }

  async ensureHelpers() {
    await this.evaluate(HELPER_SOURCE);
  }

  async #helperCall(call) {
    const expression = `window.__acc.${call}`;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.evaluate(expression);
      } catch (error) {
        lastError = error;
        // Only a missing/stale helper document is recoverable here; re-injecting
        // and retrying anything else (a real waitFor timeout, an assertion
        // failure) would just double the wait or hide the problem.
        if (attempt > 0 || !isMissingHelperError(describeError(error))) {
          throw error;
        }
        await this.ensureHelpers();
      }
    }
    throw lastError;
  }

  async waitFor(selector, timeoutMs = 15_000) {
    return this.#helperCall(
      `waitFor(${JSON.stringify(selector)}, ${Math.round(timeoutMs)})`,
    );
  }

  async setValue(selector, value) {
    return this.#helperCall(
      `setValue(${JSON.stringify(selector)}, ${JSON.stringify(value)})`,
    );
  }

  async click(selector) {
    return this.#helperCall(`click(${JSON.stringify(selector)})`);
  }

  async text(selector) {
    return this.#helperCall(`text(${JSON.stringify(selector)})`);
  }

  async count(selector) {
    return this.#helperCall(`count(${JSON.stringify(selector)})`);
  }

  async bodyText() {
    return this.#helperCall("bodyText()");
  }

  async pressKey({ key, code, windowsVirtualKeyCode, modifiers = 0, text }) {
    await this.cdp.send(
      "Target.activateTarget",
      { targetId: this.targetId },
      null,
    );
    const base = {
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      modifiers,
    };
    const keyDown =
      text === undefined
        ? { type: "keyDown", ...base }
        : { type: "keyDown", ...base, text };
    await this.cdp.send("Input.dispatchKeyEvent", keyDown, this.sessionId);
    await this.cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...base },
      this.sessionId,
    );
  }

  async navigate(url) {
    const loaded = this.cdp
      .onceEvent("Page.loadEventFired", this.sessionId, 15_000)
      .catch(() => null);
    const result = await this.cdp.send(
      "Page.navigate",
      { url },
      this.sessionId,
    );
    if (result.errorText !== undefined) {
      throw new Error(`navigation to ${url} failed: ${result.errorText}`);
    }
    await loaded;
    await sleep(50);
    await this.ensureHelpers();
  }

  async screenshot(file) {
    await this.cdp.send(
      "Target.activateTarget",
      { targetId: this.targetId },
      null,
    );
    await sleep(120);
    const shot = await this.cdp.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      this.sessionId,
    );
    const buffer = Buffer.from(shot.data, "base64");
    await writeFile(file, buffer);
    return buffer.length;
  }
}

async function openTab(cdp, label, url) {
  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  const tab = new Tab(cdp, created.targetId, attached.sessionId, label);
  state.tabs.push(tab);

  await cdp.send("Page.enable", {}, tab.sessionId);
  await cdp.send("Runtime.enable", {}, tab.sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", METRICS, tab.sessionId);
  await tab.navigate(url);
  return tab;
}

/* -------------------------------------------------------------------------- */
/* Chromium lifecycle                                                          */
/* -------------------------------------------------------------------------- */

async function waitForDevTools(activePortFile, chrome, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) {
      throw new Error(
        `chromium exited (code ${chrome.exitCode}) before DevTools was ready; stderr: ${state.chromeStderr.trim().slice(-600)}`,
      );
    }
    try {
      const raw = await readFile(activePortFile, "utf8");
      const lines = raw.split("\n");
      const port = Number((lines[0] ?? "").trim());
      const browserPath = (lines[1] ?? "").trim();
      if (
        Number.isInteger(port) &&
        port > 0 &&
        browserPath.startsWith("/devtools/")
      ) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await sleep(100);
  }
  throw new Error(`DevToolsActivePort was not ready within ${timeoutMs}ms`);
}

async function findOnPath(name) {
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

async function resolveChromium() {
  const configured = process.env.CHROMIUM_BIN?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  for (const name of CHROMIUM_CANDIDATES) {
    const found = await findOnPath(name);
    if (found !== null) {
      return found;
    }
  }
  throw new Error(
    `could not find a chromium binary; set CHROMIUM_BIN or install one of: ${CHROMIUM_CANDIDATES.join(", ")}`,
  );
}

async function launchChromium() {
  const bin = await resolveChromium();
  state.chromePath = bin;
  state.tmpDir = await mkdtemp(path.join(tmpdir(), "curved-acceptance-chrome-"));

  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${state.tmpDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-proxy-server",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "about:blank",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.unshift("--no-sandbox");
  }

  const chrome = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  state.chrome = chrome;
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    state.chromeStderr = `${state.chromeStderr}${chunk}`.slice(-8000);
  });
  chrome.on("exit", (code, signal) => {
    if (state.finished) {
      return;
    }
    void fail(
      `chromium exited unexpectedly (code=${code}, signal=${signal}); stderr: ${state.chromeStderr.trim().slice(-600)}`,
    );
  });
  chrome.on("error", (error) => {
    if (!state.finished) {
      void fail(`failed to start chromium (${bin}): ${error.message}`);
    }
  });

  return waitForDevTools(
    path.join(state.tmpDir, "DevToolsActivePort"),
    chrome,
    15_000,
  );
}

async function cleanup() {
  if (state.cleanedUp) {
    return;
  }
  state.cleanedUp = true;

  const cdp = state.cdp;
  if (cdp !== null) {
    for (const tab of state.tabs) {
      try {
        await withTimeout(
          cdp.send("Target.closeTarget", { targetId: tab.targetId }),
          500,
          "close target",
        );
      } catch {
        // Target may already be gone.
      }
    }
    cdp.close();
  }

  const chrome = state.chrome;
  if (chrome !== null && chrome.exitCode === null) {
    try {
      chrome.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    try {
      await Promise.race([once(chrome, "exit"), sleep(3000)]);
    } catch {
      // Ignore: best-effort shutdown.
    }
  }

  if (state.tmpDir !== null) {
    try {
      await rm(state.tmpDir, { recursive: true, force: true });
    } catch {
      // Profile cleanup is best-effort.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Failure and success paths                                                  */
/* -------------------------------------------------------------------------- */

async function fail(reason) {
  if (state.finished) {
    return;
  }
  state.finished = true;
  clearTimeout(watchdog);

  const lines = [`FAIL browser: ${reason}`, `phase: ${state.phase}`];
  if (state.chromePath !== null) {
    lines.push(`chromium: ${state.chromePath}`);
  }

  const bodyLines = [];
  for (const tab of state.tabs) {
    try {
      const text = await withTimeout(
        tab.bodyText(),
        1500,
        `tab ${tab.label} body text`,
      );
      bodyLines.push(`--- tab ${tab.label} body (${String(text).length} chars) ---`);
      bodyLines.push(...String(text).split(/\r?\n/));
    } catch (error) {
      bodyLines.push(
        `--- tab ${tab.label} body unavailable: ${describeError(error)} ---`,
      );
    }
  }
  if (bodyLines.length > 0) {
    lines.push("page body (first 40 lines):");
    lines.push(...bodyLines.slice(0, 40));
  }

  if (state.consoleLines.length > 0) {
    lines.push("console tail:");
    lines.push(...state.consoleLines.slice(-15));
  }

  const stderrTail = state.chromeStderr.trim();
  if (stderrTail.length > 0) {
    lines.push("chromium stderr tail:");
    lines.push(...stderrTail.split(/\r?\n/).slice(-15));
  }

  await cleanup();

  for (const line of lines) {
    try {
      await errOut(line);
    } catch {
      // Nothing useful left to do if stderr is gone.
    }
  }
  process.exit(1);
}

async function success(lines) {
  // A watchdog/chromium-exit failure may already be in flight; never let a green
  // exit overwrite it (fail() flips this flag before doing any async work).
  if (state.finished) {
    return;
  }
  state.finished = true;
  clearTimeout(watchdog);
  for (const line of lines) {
    await out(line);
  }
  await cleanup();
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Assertions that poll the page                                              */
/* -------------------------------------------------------------------------- */

async function waitForBodyContains(tab, needle, timeoutMs) {
  const started = Date.now();
  let lastLength = 0;
  while (Date.now() - started < timeoutMs) {
    const body = String(await tab.bodyText());
    lastLength = body.length;
    if (body.includes(needle)) {
      return;
    }
    await sleep(40);
  }
  throw new Error(
    `tab ${tab.label} body never contained ${JSON.stringify(needle)} within ${timeoutMs}ms (body length ${lastLength})`,
  );
}

async function waitForTimelineContains(tab, needle, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await tab.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="timeline-event"]')).some((element) => String(element.textContent || "").includes(${JSON.stringify(needle)}))`,
    );
    if (hit === true) {
      return;
    }
    await sleep(50);
  }
  throw new Error(
    `tab ${tab.label} timeline never contained ${JSON.stringify(needle)} within ${timeoutMs}ms`,
  );
}

function readStatusTabs(tab) {
  return tab.evaluate(
    `Array.from(document.querySelectorAll('[data-testid^="status-tab-"]')).map((element) => ({
      status: element.getAttribute("data-status"),
      count: element.getAttribute("data-count"),
    }))`,
  );
}

function assertStatusTabs(rows) {
  assert(Array.isArray(rows), "could not read status tabs from the board");
  assert(
    rows.length === 5,
    `expected 5 status tabs, found ${rows.length} (${rows
      .map((row) => row.status)
      .join(", ")})`,
  );

  const counts = new Map();
  for (const row of rows) {
    assert(
      typeof row.status === "string" && STATUSES.includes(row.status),
      `status tab has unexpected data-status ${JSON.stringify(row.status)}`,
    );
    assert(
      !counts.has(row.status),
      `duplicate status tab for ${row.status}`,
    );
    assert(
      typeof row.count === "string" && row.count.trim().length > 0,
      `status tab ${row.status} is missing data-count`,
    );
    const parsed = Number(row.count);
    assert(
      Number.isFinite(parsed),
      `status tab ${row.status} data-count ${JSON.stringify(row.count)} is not a number`,
    );
    counts.set(row.status, parsed);
  }

  for (const status of STATUSES) {
    assert(counts.has(status), `missing status tab for ${status}`);
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Flow                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  state.phase = "validate environment";
  const baseUrl = readEnv("ACCEPTANCE_BASE_URL").replace(/\/+$/, "");
  const uiToken = readEnv("ACCEPTANCE_UI_TOKEN");
  const projectKey = readEnv("ACCEPTANCE_PROJECT_KEY");

  state.phase = "launch chromium";
  const webSocketUrl = await launchChromium();

  state.phase = "connect to CDP";
  state.cdp = await Cdp.connect(webSocketUrl, 15_000);
  state.cdp.onEvent((message) => {
    if (message.method !== "Runtime.consoleAPICalled") {
      return;
    }
    const tab = state.tabs.find((item) => item.sessionId === message.sessionId);
    const params = message.params ?? {};
    const args = Array.isArray(params.args) ? params.args : [];
    const text = args
      .map((arg) =>
        arg.value !== undefined
          ? String(arg.value)
          : String(arg.description ?? arg.type ?? ""),
      )
      .join(" ");
    state.consoleLines.push(`[tab ${tab?.label ?? "?"} console.${params.type}] ${text}`);
    if (state.consoleLines.length > 100) {
      state.consoleLines.splice(0, state.consoleLines.length - 100);
    }
  });

  state.phase = "open first tab";
  const boardUrl = `${baseUrl}/p/${encodeURIComponent(projectKey)}`;
  const tabA = await openTab(state.cdp, "A", boardUrl);

  state.phase = "sign in";
  await tabA.waitFor(SIGNIN_TOKEN, 20_000);
  await tabA.setValue(SIGNIN_TOKEN, uiToken);
  await tabA.click(SIGNIN_SUBMIT);
  await tabA.waitFor(STATUS_TAB, 20_000);

  state.phase = "check mobile board";
  const viewport = await tabA.evaluate(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  assert(
    viewport.width === 390,
    `expected a 390px viewport, got ${viewport.width}x${viewport.height}`,
  );

  const statusRows = await readStatusTabs(tabA);
  const counts = assertStatusTabs(statusRows);

  const barRect = await tabA.evaluate(
    `(() => {
      const first = document.querySelector('[data-testid^="status-tab-"]');
      const bar = first === null ? null : (first.closest("nav") || first.parentElement);
      if (bar === null) {
        return null;
      }
      const box = bar.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })()`,
  );
  assert(barRect !== null, "status tab bar was not found");
  assert(
    barRect.width > 0 && barRect.height > 0,
    `status tab bar is not visible (${barRect.width}x${barRect.height})`,
  );

  // Evidence for the tab bar that was just asserted: capture it while the board
  // is still the visible document, before the palette opens over it.
  state.phase = "screenshot board";
  await sleep(150);
  const screenshotBoardBytes = await tabA.screenshot(SCREENSHOT_BOARD);

  state.phase = "open command palette";
  await tabA.pressKey(CTRL_K);
  await tabA.waitFor(PALETTE, 5000);
  await tabA.setValue(PALETTE_INPUT, "new issue");
  await tabA.waitFor("#palette-new-issue", 5000);
  await tabA.pressKey(ENTER_KEY);
  await tabA.waitFor(NEW_ISSUE_TITLE, 10_000);

  state.phase = "create issue";
  await tabA.setValue(NEW_ISSUE_TITLE, "Browser acceptance task");
  await tabA.click(NEW_ISSUE_SUBMIT);
  await tabA.waitFor('[data-testid="toast"]', 5000);
  await tabA.waitFor(ISSUE_DETAIL, 15_000);

  const issuePath = String(await tabA.evaluate("window.location.pathname"));
  const issueMatch = /^\/p\/([^/]+)\/i\/([^/]+)\/?$/.exec(issuePath);
  assert(
    issueMatch !== null,
    `expected an issue route after creating, got ${JSON.stringify(issuePath)}`,
  );
  const routeProject = decodeURIComponent(issueMatch[1]);
  const issueKey = decodeURIComponent(issueMatch[2]);
  assert(
    routeProject === projectKey,
    `created issue route is for project ${routeProject}, expected ${projectKey}`,
  );

  state.phase = "screenshot issue detail";
  await sleep(200);
  const screenshotDetailBytes = await tabA.screenshot(SCREENSHOT_DETAIL);

  state.phase = "open second tab";
  const tabBSession = await openTab(
    state.cdp,
    "B",
    `${baseUrl}${issuePath}`,
  );
  await tabBSession.waitFor(ISSUE_DETAIL, 20_000);
  await tabBSession.waitFor(TIMELINE_EVENT, 15_000);
  const eventsB = await tabBSession.count(TIMELINE_EVENT);
  assert(
    eventsB >= 1,
    `second tab rendered no timeline events for ${issueKey}`,
  );
  // Give the fresh tab's EventSource a beat to open before timing realtime.
  await sleep(300);

  state.phase = "comment propagation";
  const marker = `browser comment ${Date.now()}`;
  await tabA.setValue(COMMENT_INPUT, marker);
  await tabA.waitFor(`${COMMENT_SUBMIT}:not([disabled])`, 5000);

  const startedAt = Date.now();
  await tabA.click(COMMENT_SUBMIT);
  await waitForBodyContains(tabBSession, marker, 6000);
  const elapsedMs = Date.now() - startedAt;
  assert(
    elapsedMs < COMMENT_LATENCY_LIMIT_MS,
    `comment took ${elapsedMs}ms to reach the second tab (limit ${COMMENT_LATENCY_LIMIT_MS}ms)`,
  );
  await waitForTimelineContains(tabA, marker, 5000);
  const eventsA = await tabA.count(TIMELINE_EVENT);

  state.phase = "screenshot second tab";
  await sleep(150);
  const screenshotBBytes = await tabBSession.screenshot(SCREENSHOT_SECOND_TAB);

  const summary = STATUSES.map((status) => `${status}=${counts.get(status)}`).join(
    " ",
  );
  const lines = [
    `PASS browser: signed in and loaded ${boardUrl} at ${viewport.width}x${viewport.height}`,
    `PASS browser: 5 status tabs visible (${summary}); tab bar ${Math.round(barRect.width)}x${Math.round(barRect.height)}px`,
    `PASS browser: board screenshot ${SCREENSHOT_BOARD} (${screenshotBoardBytes} bytes)`,
    `PASS browser: command palette + new issue dialog created ${issueKey} at ${issuePath} (toast shown)`,
    `PASS browser: detail screenshot ${SCREENSHOT_DETAIL} (${screenshotDetailBytes} bytes)`,
    `PASS browser: second tab opened ${issuePath} with ${eventsB} timeline event(s)`,
    `PASS browser: comment propagated tab A -> tab B in ${elapsedMs}ms (< ${COMMENT_LATENCY_LIMIT_MS}ms; marker ${JSON.stringify(marker)}; tab A timeline events ${eventsA})`,
    `PASS browser: second-tab screenshot ${SCREENSHOT_SECOND_TAB} (${screenshotBBytes} bytes)`,
  ];
  await success(lines);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

watchdog = setTimeout(() => {
  void fail(`hard timeout after ${HARD_TIMEOUT_MS}ms`);
}, HARD_TIMEOUT_MS);

main().catch((error) => {
  void fail(describeError(error));
});
