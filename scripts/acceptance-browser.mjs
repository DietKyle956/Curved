#!/usr/bin/env node
// Browser leg of the LAS-155 acceptance gate.
//
// A dependency-free Chromium driver over the DevTools Protocol. It signs in,
// exercises the mobile board (status tabs, command palette, new issue dialog),
// then checks that a comment posted in one tab reaches a second tab over the
// realtime channel without a reload.
//
// Environment (set by scripts/acceptance.mjs):
//   ACCEPTANCE_BASE_URL     e.g. http://localhost:12345 (a secure context, so
//                           WebAuthn ceremonies work)
//   ACCEPTANCE_UI_TOKEN     UI token used to sign in
//   ACCEPTANCE_PROJECT_KEY  existing project key, e.g. TAC
//   ACCEPTANCE_SIGNIN_ONLY  "1" runs only the stale-passkey sign-in regression:
//                           the page at ACCEPTANCE_BASE_URL must disable the
//                           passkey button, explain the domain mismatch, and
//                           keep the token form. No other leg runs.
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
const SCREENSHOT_PALETTE = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-palette.png`,
);
const SCREENSHOT_PROJECTS = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-projects.png`,
);
const SCREENSHOT_PROJECT_OVERVIEW = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-project-overview.png`,
);
const SCREENSHOT_PROJECTS_CARD = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-projects-card.png`,
);
const SCREENSHOT_PROJECT_DIALOG = path.join(
  tmpdir(),
  `curved-acceptance-${RUN_ID}-project-dialog.png`,
);

const CHROMIUM_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
];
const HARD_TIMEOUT_MS = 180_000;
const COMMENT_LATENCY_LIMIT_MS = 1100;
// The active palette row must keep a visible gutter above the listbox bottom;
// a row flush against the edge reads as a clipped row.
const PALETTE_BOTTOM_GUTTER_PX = 4;

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
const SIGNIN_PASSKEY = '[data-testid="signin-passkey"]';
const PASSKEYS_OPEN = '[data-testid="open-passkeys"]';
const PASSKEY_NICKNAME = '[data-testid="passkey-nickname"]';
const PASSKEY_ADD = '[data-testid="passkey-add"]';
const PASSKEY_ROW = '[data-testid="passkey-row"]';
const PASSKEYS_DIALOG = '[role="dialog"][aria-labelledby="dialog-title"]';
const PASSKEYS_ERROR = '[data-testid="passkeys-error"]';
const STATUS_TAB = '[data-testid^="status-tab-"]';
const PALETTE = '[role="dialog"][aria-label="Command palette"]';
const PALETTE_INPUT = 'input[role="combobox"]';
const PALETTE_RESULTS = "#palette-results";
const PALETTE_OPTION = '#palette-results [role="option"]';
const PALETTE_KEY = '[data-testid="palette-key"]';
const PALETTE_PROJECTS_OPTION = "#palette-projects";
const PALETTE_BOARD_OPTION = "#palette-board";
const NEW_ISSUE_TITLE = '[data-testid="new-issue-title"]';
const NEW_ISSUE_SUBMIT = '[data-testid="new-issue-submit"]';
const NEW_ISSUE_BLOCKED_BY = '[data-testid="new-issue-blocked-by"]';
const NEW_ISSUE_PARENT = '[data-testid="new-issue-parent"]';
const ISSUE_PARENT_ROW = '[data-testid="issue-parent-row"]';
const ISSUE_CHILDREN_ROW = '[data-testid="issue-children-row"]';
const ISSUE_DETAIL = '[data-testid="issue-detail"]';
const EDIT_RELATIONS = '[data-testid="edit-relations"]';
const RELATION_DIALOG = '[data-testid="relation-dialog"]';
const RELATION_BLOCKS = '[data-testid="relation-blocks"]';
const RELATION_BLOCKED_BY = '[data-testid="relation-blocked-by"]';
const RELATION_SAVE = '[data-testid="relation-save"]';
const RELATION_BLOCKED_BY_ROW = '[data-testid="relation-blocked-by-row"]';
const RELATION_BLOCKS_ROW = '[data-testid="relation-blocks-row"]';
const TIMELINE_EVENT = '[data-testid="timeline-event"]';
const COMMENT_INPUT = "#issue-comment";
const COMMENT_SUBMIT = '[data-testid="comment-submit"]';
const MOBILE_NAV = 'nav[aria-label="Primary"]';
const PROJECTS_PAGE = '[data-testid="projects-page"]';
const NEW_PROJECT = '[data-testid="new-project"]';
const PROJECT_DIALOG = '[data-testid="project-dialog"]';
const PROJECT_KEY_INPUT = '[data-testid="project-key"]';
const PROJECT_NAME_INPUT = '[data-testid="project-name"]';
const PROJECT_SUMMARY_INPUT = '[data-testid="project-summary"]';
const PROJECT_SAVE = '[data-testid="project-save"]';
const PROJECT_OVERVIEW = '[data-testid="project-overview"]';
const PROJECT_CARD = '[data-testid="project-card-WEB"]';
const PROJECT_CARD_ANY = '[data-testid^="project-card-"]';
const PROJECT_EDIT = '[data-testid="project-edit"]';
const PROJECT_PROGRESS = '[data-testid="project-progress"]';

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

const ARROW_DOWN = {
  key: "ArrowDown",
  code: "ArrowDown",
  windowsVirtualKeyCode: 40,
  modifiers: 0,
};

const ESCAPE_KEY = {
  key: "Escape",
  code: "Escape",
  windowsVirtualKeyCode: 27,
  modifiers: 0,
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
  palette: null,
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
  // Headless tabs are not focused by default, which makes WebAuthn reject the
  // ceremony with NotAllowedError ("the page does not have focus").
  await cdp.send(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    tab.sessionId,
  );
  await tab.navigate(url);
  return tab;
}

/**
 * Gives Chromium a software authenticator so the passkey legs can register a
 * credential and assert with it without a human or real hardware. Commands are
 * sent on the page session, which is where the WebAuthn domain lives.
 */
async function enableVirtualAuthenticator(tab) {
  await state.cdp.send("WebAuthn.enable", {}, tab.sessionId);
  const added = await state.cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
    tab.sessionId,
  );
  const authenticatorId = added?.authenticatorId;
  if (typeof authenticatorId !== "string" || authenticatorId.length === 0) {
    throw new Error(
      `WebAuthn.addVirtualAuthenticator returned no authenticatorId: ${JSON.stringify(added)}`,
    );
  }
  return authenticatorId;
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

  // Per-tab excerpts, each capped at 20 lines: concatenating every tab and
  // slicing the front of the result only ever showed tab A, hiding exactly the
  // tab that failed.
  const BODY_LINES_PER_TAB = 20;
  for (const tab of state.tabs) {
    try {
      const text = await withTimeout(
        tab.bodyText(),
        1500,
        `tab ${tab.label} body text`,
      );
      const tabLines = String(text).split(/\r?\n/);
      lines.push(
        `--- tab ${tab.label} body (first ${BODY_LINES_PER_TAB} of ${tabLines.length} lines, ${String(text).length} chars) ---`,
      );
      lines.push(...tabLines.slice(0, BODY_LINES_PER_TAB));
    } catch (error) {
      lines.push(
        `--- tab ${tab.label} body unavailable: ${describeError(error)} ---`,
      );
    }
  }

  if (state.palette !== null) {
    lines.push("palette diagnostics:", ...state.palette);
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

async function waitForBodyMatch(tab, matches, needle, timeoutMs) {
  const started = Date.now();
  let lastLength = 0;
  while (Date.now() - started < timeoutMs) {
    const body = String(await tab.bodyText());
    lastLength = body.length;
    if (matches(body)) {
      return;
    }
    await sleep(40);
  }
  throw new Error(
    `tab ${tab.label} body never contained ${JSON.stringify(needle)} within ${timeoutMs}ms (body length ${lastLength})`,
  );
}

async function waitForBodyContains(tab, needle, timeoutMs) {
  await waitForBodyMatch(tab, (body) => body.includes(needle), needle, timeoutMs);
}

async function waitForBodyContainsIgnoringCase(tab, needle, timeoutMs) {
  const lowered = needle.toLowerCase();
  await waitForBodyMatch(
    tab,
    (body) => body.toLowerCase().includes(lowered),
    needle,
    timeoutMs,
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

async function waitForSelectorGone(tab, selector, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await tab.count(selector)) === 0) {
      return;
    }
    await sleep(40);
  }
  throw new Error(
    `tab ${tab.label} still rendered ${JSON.stringify(selector)} after ${timeoutMs}ms`,
  );
}

function readBox(tab, selector) {
  return tab.evaluate(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element === null) {
        return null;
      }
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    })()`,
  );
}

/**
 * Waits until `selector` has a non-zero box that stopped moving between polls.
 * Dialogs slide and scale in after mounting, so a click issued while the panel
 * is still animating can land on the backdrop instead of the target.
 */
async function waitForStableBox(tab, selector, timeoutMs = 3000) {
  const started = Date.now();
  let previous = null;
  let current = null;
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    current = await readBox(tab, selector);
    if (
      current !== null &&
      current.width > 0 &&
      current.height > 0 &&
      previous !== null &&
      current.x === previous.x &&
      current.y === previous.y &&
      current.width === previous.width &&
      current.height === previous.height
    ) {
      stable += 1;
      if (stable >= 2) {
        return current;
      }
    } else {
      stable = 0;
    }
    previous = current;
    await sleep(50);
  }
  if (current === null || current.width <= 0 || current.height <= 0) {
    throw new Error(
      `tab ${tab.label} ${JSON.stringify(selector)} never got a non-zero box within ${timeoutMs}ms (last ${JSON.stringify(current)})`,
    );
  }
  return current;
}

/**
 * Snapshot of what the passkeys dialog did after the add click: a registered
 * row, an inline error, or the dialog closing (backdrop click or sign-out).
 */
function readPasskeyAddState(tab) {
  return tab.evaluate(
    `(() => {
      const dialog = document.querySelector(${JSON.stringify(PASSKEYS_DIALOG)});
      const add = document.querySelector(${JSON.stringify(PASSKEY_ADD)});
      const row = document.querySelector(${JSON.stringify(PASSKEY_ROW)});
      const error = document.querySelector(${JSON.stringify(PASSKEYS_ERROR)});
      const box = add === null ? null : add.getBoundingClientRect();
      const dialogText = dialog === null ? "" : String(dialog.textContent || "");
      return {
        dialog: dialog !== null,
        row: row !== null,
        error: error === null ? null : String(error.textContent || "").trim(),
        addRect:
          box === null
            ? null
            : { x: box.x, y: box.y, width: box.width, height: box.height },
        path: window.location.pathname,
        signInForm:
          document.querySelector(${JSON.stringify(SIGNIN_TOKEN)}) !== null,
        disabled: add === null ? null : add.disabled,
        buttonText: add === null ? null : String(add.textContent || "").trim(),
        loading: dialogText.includes("Loading passkeys"),
        toasts: Array.from(
          document.querySelectorAll('[data-testid="toast"]'),
        ).map((toast) => String(toast.textContent || "").trim()),
        dialogTail:
          dialog === null
            ? null
            : String(dialog.innerText || "").slice(-240),
      };
    })()`,
  );
}

async function waitForPasskeyAddOutcome(tab, timeoutMs) {
  const started = Date.now();
  let current = await readPasskeyAddState(tab);
  while (Date.now() - started < timeoutMs) {
    if (current.row || current.error !== null || !current.dialog) {
      return current;
    }
    await sleep(50);
    current = await readPasskeyAddState(tab);
  }
  return current;
}

/**
 * Reads the palette's issue options plus, when exactly one matches, its key
 * span. The key text is the raw textContent, so a lowercase label regression
 * fails even though a CSS `uppercase` would not change textContent.
 */
function readPaletteOptions(tab) {
  return tab.evaluate(
    `(() => {
      const list = document.querySelector(${JSON.stringify(PALETTE_RESULTS)});
      if (list === null) {
        return { list: false };
      }
      const options = Array.from(list.querySelectorAll('[role="option"]'));
      const issueOptions = options.filter((option) =>
        String(option.id).startsWith("palette-issue-"),
      );
      const option = issueOptions.length === 1 ? issueOptions[0] : null;
      const key = option === null ? null : option.querySelector('[data-testid="palette-key"]');
      const optionBox = option === null ? null : option.getBoundingClientRect();
      const keyBox = key === null ? null : key.getBoundingClientRect();
      const box = (rect) =>
        rect === null ? null : { width: rect.width, height: rect.height };
      return {
        list: true,
        optionCount: options.length,
        issueOptionIds: issueOptions.map((item) => item.id),
        keyPresent: key !== null,
        keyText: key === null ? null : String(key.textContent ?? ""),
        optionBox: box(optionBox),
        keyBox: box(keyBox),
      };
    })()`,
  );
}

/** Reads the listbox scroll geometry and the selected row's bounds. */
function readPaletteScroll(tab) {
  return tab.evaluate(
    `(() => {
      const list = document.querySelector(${JSON.stringify(PALETTE_RESULTS)});
      if (list === null) {
        return { list: false };
      }
      const options = Array.from(list.querySelectorAll('[role="option"]'));
      const selected = list.querySelector('[role="option"][aria-selected="true"]');
      const input = document.querySelector('input[role="combobox"]');
      const listBox = list.getBoundingClientRect();
      const rowBox = selected === null ? null : selected.getBoundingClientRect();
      return {
        list: true,
        optionCount: options.length,
        lastOptionId: options.length === 0 ? null : options[options.length - 1].id,
        selectedId: selected?.id ?? null,
        activeDescendant:
          input === null ? null : input.getAttribute("aria-activedescendant"),
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        listTop: listBox.top,
        listBottom: listBox.bottom,
        rowTop: rowBox === null ? null : rowBox.top,
        rowBottom: rowBox === null ? null : rowBox.bottom,
      };
    })()`,
  );
}

/**
 * Polls until the palette's issue-option count satisfies `settled`. Typing
 * updates React state asynchronously, so reading the list immediately after a
 * key event would still see the previous query's rows.
 */
async function waitForIssueOptions(tab, settled, timeoutMs) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeoutMs) {
    snapshot = await readPaletteOptions(tab);
    if (
      snapshot !== null &&
      snapshot.list === true &&
      settled(snapshot.issueOptionIds.length)
    ) {
      return snapshot;
    }
    await sleep(50);
  }
  return snapshot;
}

/**
 * Polls until the listbox has scrolled, then returns the settled snapshot. A
 * list that never scrolls still returns its snapshot so the caller's assertion
 * reports the real geometry instead of a timeout.
 */
async function waitForPaletteScroll(tab, timeoutMs) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeoutMs) {
    snapshot = await readPaletteScroll(tab);
    if (snapshot !== null && snapshot.list === true && snapshot.scrollTop > 0) {
      return snapshot;
    }
    await sleep(50);
  }
  return snapshot;
}

/**
 * Runs a palette action by typing `query` and clicking the option `optionId`.
 * The palette closes itself on click, so the exit animation is waited out
 * before the caller inspects the newly routed page. Navigating through the
 * palette keeps the run on the app's own pushState navigation instead of a
 * full document load, which would leave the previous document's EventSource
 * connections alive in BFCache.
 */
async function runPaletteAction(tab, query, optionId) {
  await tab.pressKey(CTRL_K);
  await tab.waitFor(PALETTE, 5000);
  await tab.setValue(PALETTE_INPUT, query);
  await tab.waitFor(optionId, 5000);
  await tab.click(optionId);
  await waitForSelectorGone(tab, PALETTE, 5000);
}

async function goToProjects(tab) {
  await runPaletteAction(tab, "projects", PALETTE_PROJECTS_OPTION);
  await tab.waitFor(PROJECTS_PAGE, 20_000);
}

/**
 * Returns to `projectKey`'s board from the projects page. The palette "board"
 * action targets the workspace's current project, which on /projects falls back
 * to the first project by key, so the project's own overview is opened first.
 */
async function goToBoardFor(tab, projectKey) {
  await runPaletteAction(
    tab,
    projectKey.toLowerCase(),
    `#palette-project-${projectKey}`,
  );
  await tab.waitFor(PROJECT_OVERVIEW, 20_000);
  await runPaletteAction(tab, "board", PALETTE_BOARD_OPTION);
  const boardPath = String(await tab.evaluate("window.location.pathname"));
  const expectedPath = `/p/${encodeURIComponent(projectKey)}`;
  assert(
    boardPath === expectedPath,
    `palette board action routed to ${JSON.stringify(boardPath)}, expected ${JSON.stringify(expectedPath)} for project ${JSON.stringify(projectKey)}`,
  );
  await tab.waitFor(STATUS_TAB, 20_000);
}

/* -------------------------------------------------------------------------- */
/* Flow                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Permanent regression for the stale-passkey sign-in surface. The throwaway
 * database holds one legacy credential whose `rp_id` is NULL, so the page must
 * treat it as unusable at this RP ID: the passkey button stays disabled, the
 * page explains the domain mismatch, and the token form remains available.
 * This leg deliberately skips the virtual authenticator and every board,
 * project, and passkey-registration step the full browser leg runs.
 */
async function signinOnlyFlow(baseUrl) {
  state.phase = "open sign-in page";
  const tab = await openTab(state.cdp, "signin", baseUrl);
  await tab.waitFor(SIGNIN_TOKEN, 20_000);
  await tab.waitFor(SIGNIN_PASSKEY, 20_000);

  // The availability probe resolves after first paint, so the explanation only
  // appears once the server has reported the credential as other-domain.
  state.phase = "wait for other-domain explanation";
  await waitForBodyContains(
    tab,
    "A passkey is registered for a different domain",
    10_000,
  );

  state.phase = "assert stale passkey is inert";
  const passkeyDisabled = await tab.evaluate(
    `document.querySelector(${JSON.stringify(SIGNIN_PASSKEY)})?.disabled === true`,
  );
  assert(
    passkeyDisabled === true,
    "the passkey sign-in button is enabled although only a different-domain credential exists",
  );

  const body = String(await tab.bodyText());
  assert(
    body.includes("A passkey is registered for a different domain"),
    `the sign-in page did not explain the other-domain passkey; page text starts ${JSON.stringify(body.slice(0, 300))}`,
  );

  const tokenFormPresent = await tab.evaluate(
    `document.querySelector(${JSON.stringify(SIGNIN_TOKEN)}) !== null &&
       document.querySelector(${JSON.stringify(SIGNIN_SUBMIT)}) !== null`,
  );
  assert(
    tokenFormPresent === true,
    "the token sign-in form is missing from the sign-in page",
  );

  await success([
    `PASS browser-signin: passkey button disabled and the page explains "A passkey is registered for a different domain" at ${baseUrl}`,
    "PASS browser-signin: token sign-in form present and ready",
  ]);
}

async function main() {
  state.phase = "validate environment";
  const baseUrl = readEnv("ACCEPTANCE_BASE_URL").replace(/\/+$/, "");
  // The sign-in-only regression never signs in or navigates to a project, so it
  // must not require the token or project key. The full browser leg still does.
  const signinOnly = process.env.ACCEPTANCE_SIGNIN_ONLY === "1";
  const uiToken = signinOnly ? "" : readEnv("ACCEPTANCE_UI_TOKEN");
  const projectKey = signinOnly ? "" : readEnv("ACCEPTANCE_PROJECT_KEY");

  state.phase = "launch chromium";
  const webSocketUrl = await launchChromium();

  state.phase = "connect to CDP";
  state.cdp = await Cdp.connect(webSocketUrl, 15_000);
  state.cdp.onEvent((message) => {
    const params = message.params ?? {};
    if (message.method !== "Runtime.consoleAPICalled") {
      return;
    }
    const tab = state.tabs.find((item) => item.sessionId === message.sessionId);
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

  if (signinOnly) {
    await signinOnlyFlow(baseUrl);
    return;
  }

  state.phase = "open first tab";
  const boardUrl = `${baseUrl}/p/${encodeURIComponent(projectKey)}`;
  const tabA = await openTab(state.cdp, "A", boardUrl);

  // The authenticator is created once per browser environment and persists
  // across page loads and navigations; adding a second one is rejected, so the
  // passkey legs reuse this id and only re-arm focus emulation.
  state.phase = "enable virtual authenticator";
  const authenticatorId = await enableVirtualAuthenticator(tabA);

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

  // Project entity leg: create a project through the SPA, then edit its status
  // through the same dialog. The page is exercised at 390px, so the projects
  // grid and the five-cell mobile nav must both fit without clipping.
  state.phase = "open projects page";
  await goToProjects(tabA);

  const projectsLayout = await tabA.evaluate(
    `(() => {
      const nav = document.querySelector(${JSON.stringify(MOBILE_NAV)});
      const grid = nav === null ? null : nav.querySelector(":scope > div");
      const cells =
        grid === null
          ? []
          : Array.from(grid.children).map((element) => {
              const box = element.getBoundingClientRect();
              return {
                label: String(element.textContent || "").trim(),
                left: box.left,
                right: box.right,
                width: box.width,
              };
            });
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        cells: cells,
      };
    })()`,
  );
  assert(
    projectsLayout !== null && typeof projectsLayout === "object",
    "could not read the projects page layout",
  );
  assert(
    projectsLayout.scrollWidth <= projectsLayout.innerWidth + 1,
    `projects page overflows horizontally at ${projectsLayout.innerWidth}px: documentElement.scrollWidth ${projectsLayout.scrollWidth}`,
  );
  assert(
    projectsLayout.cells.length === 5,
    `expected 5 mobile nav cells on the projects page, found ${projectsLayout.cells.length} (${projectsLayout.cells.map((cell) => JSON.stringify(cell.label)).join(", ") || "none"})`,
  );
  const navCellOverflow = projectsLayout.cells.filter(
    (cell) =>
      cell.left < -1 ||
      cell.width <= 0 ||
      cell.right > projectsLayout.innerWidth + 1,
  );
  assert(
    navCellOverflow.length === 0,
    `mobile nav cells do not fit the ${projectsLayout.innerWidth}px viewport: ${navCellOverflow
      .map(
        (cell) =>
          `${JSON.stringify(cell.label)} ${Math.round(cell.left)}-${Math.round(cell.right)} (${Math.round(cell.width)}px)`,
      )
      .join(", ")}; all cells: ${projectsLayout.cells
      .map(
        (cell) =>
          `${JSON.stringify(cell.label)} ${Math.round(cell.left)}-${Math.round(cell.right)} (${Math.round(cell.width)}px)`,
      )
      .join(", ")}`,
  );
  const navCellsWidth = projectsLayout.cells.reduce(
    (total, cell) => total + cell.width,
    0,
  );

  state.phase = "screenshot projects page";
  await sleep(150);
  const screenshotProjectsBytes = await tabA.screenshot(SCREENSHOT_PROJECTS);

  state.phase = "create project";
  await tabA.click(NEW_PROJECT);
  await tabA.waitFor(PROJECT_DIALOG, 10_000);
  await tabA.setValue(PROJECT_KEY_INPUT, "WEB");
  await tabA.setValue(PROJECT_NAME_INPUT, "Web project");
  await tabA.setValue(PROJECT_SUMMARY_INPUT, "Created in the browser");
  await tabA.click(PROJECT_SAVE);
  await tabA.waitFor(PROJECT_OVERVIEW, 15_000);
  await waitForBodyContains(tabA, "Web project", 5000);

  const projectOverviewPath = String(
    await tabA.evaluate("window.location.pathname"),
  );
  assert(
    projectOverviewPath === "/p/WEB/overview",
    `expected the created project overview at /p/WEB/overview, got ${JSON.stringify(projectOverviewPath)}`,
  );
  const projectBodyText = String(await tabA.bodyText());
  assert(
    projectBodyText.includes("Web project"),
    "project overview body does not show the project name \"Web project\"",
  );
  const projectProgressText = String(await tabA.text(PROJECT_PROGRESS))
    .replace(/\s+/g, " ")
    .trim();
  assert(
    projectProgressText.includes("0%"),
    `project progress read ${JSON.stringify(projectProgressText)}, expected it to contain "0%"`,
  );

  state.phase = "screenshot project overview";
  await sleep(150);
  const screenshotProjectOverviewBytes = await tabA.screenshot(
    SCREENSHOT_PROJECT_OVERVIEW,
  );

  state.phase = "edit project status";
  await tabA.click(PROJECT_EDIT);
  await tabA.waitFor(PROJECT_DIALOG, 10_000);
  await tabA.evaluate(`(() => {
    const el = document.querySelector('[data-testid="project-status"]');
    el.value = "in_progress";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`);

  state.phase = "screenshot project dialog";
  await sleep(150);
  const screenshotProjectDialogBytes = await tabA.screenshot(
    SCREENSHOT_PROJECT_DIALOG,
  );

  await tabA.click(PROJECT_SAVE);
  await waitForSelectorGone(tabA, PROJECT_DIALOG, 10_000);
  await tabA.waitFor(PROJECT_OVERVIEW, 10_000);
  await waitForBodyContainsIgnoringCase(tabA, "In progress", 5000);
  const projectStatusText = String(await tabA.text(PROJECT_OVERVIEW))
    .replace(/\s+/g, " ")
    .trim();
  assert(
    /in progress/i.test(projectStatusText),
    `project overview read ${JSON.stringify(projectStatusText)}, expected the project status chip to read In progress (case-insensitive)`,
  );

  // The created project must also render as a card on the projects page: the
  // initial projects screenshot predates creation, so verify the card itself
  // (geometry inside the 390px viewport, key/name/progress text) before the
  // board legs resume. The status edit a moment ago does not change 0/0.
  state.phase = "check project card";
  await goToProjects(tabA);
  await tabA.waitFor(PROJECT_CARD, 20_000);
  const projectCard = await tabA.evaluate(
    `(() => {
      const card = document.querySelector(${JSON.stringify(PROJECT_CARD)});
      if (card === null) {
        return null;
      }
      const box = card.getBoundingClientRect();
      const cards = document.querySelectorAll(${JSON.stringify(PROJECT_CARD_ANY)});
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        text: String(card.textContent || "").replace(/\\s+/g, " ").trim(),
        projectCount: cards.length,
      };
    })()`,
  );
  assert(
    projectCard !== null && typeof projectCard === "object",
    `project card ${PROJECT_CARD} was not found on the projects page`,
  );
  assert(
    projectCard.width > 0 && projectCard.height > 0,
    `project card is not visible (${Math.round(projectCard.width)}x${Math.round(projectCard.height)})`,
  );
  assert(
    projectCard.left >= -1 &&
      projectCard.right <= projectCard.innerWidth + 1,
    `project card spans ${Math.round(projectCard.left)}-${Math.round(projectCard.right)}px in a ${projectCard.innerWidth}px viewport`,
  );
  assert(
    projectCard.scrollWidth <= projectCard.innerWidth + 1,
    `projects page overflows horizontally at ${projectCard.innerWidth}px: documentElement.scrollWidth ${projectCard.scrollWidth}`,
  );
  assert(
    projectCard.text.includes("WEB"),
    `project card text does not show the key "WEB": ${JSON.stringify(projectCard.text)}`,
  );
  assert(
    projectCard.text.includes("Web project"),
    `project card text does not show the project name "Web project": ${JSON.stringify(projectCard.text)}`,
  );
  assert(
    projectCard.text.includes("0/0"),
    `project card text does not show progress "0/0": ${JSON.stringify(projectCard.text)}`,
  );

  state.phase = "screenshot project card";
  await sleep(150);
  const screenshotProjectsCardBytes = await tabA.screenshot(
    SCREENSHOT_PROJECTS_CARD,
  );

  // Return to the board so the palette and issue legs below run unchanged.
  state.phase = "return to board";
  await goToBoardFor(tabA, projectKey);

  // LAS-154 regression: an issue row must render its key in the palette, and a
  // key search must narrow the list to that one issue. The seeded set holds
  // exactly one issue whose key matches this fragment (no other key, and no
  // title, contains it), while the query is lowercase and the rendered key is
  // uppercase, so a case-sensitive filter would return nothing.
  state.phase = "palette key search";
  const keyedIssueKey = `${projectKey}-4`;
  const keyedFragment = keyedIssueKey.toLowerCase();
  await tabA.pressKey(CTRL_K);
  await tabA.waitFor(PALETTE, 5000);
  await tabA.setValue(PALETTE_INPUT, keyedFragment);
  const keyMatch = await waitForIssueOptions(tabA, (count) => count === 1, 5000);
  state.palette = [
    `key search ${JSON.stringify(keyedFragment)} -> ${JSON.stringify(keyMatch)}`,
  ];
  assert(
    keyMatch !== null && keyMatch.list === true,
    `palette results listbox ${PALETTE_RESULTS} was not found during the key search check`,
  );
  assert(
    keyMatch.issueOptionIds.length === 1,
    `expected exactly one issue option for ${JSON.stringify(keyedFragment)}, found ${keyMatch.issueOptionIds.length} (${keyMatch.issueOptionIds.join(", ") || "none"})`,
  );
  assert(
    keyMatch.issueOptionIds[0] === `palette-issue-${keyedIssueKey}`,
    `single issue option for ${JSON.stringify(keyedFragment)} was ${JSON.stringify(keyMatch.issueOptionIds[0])}, expected palette-issue-${keyedIssueKey}`,
  );
  assert(
    keyMatch.keyPresent,
    `issue option for ${keyedIssueKey} rendered no ${PALETTE_KEY} span`,
  );
  assert(
    keyMatch.keyText === keyedIssueKey,
    `palette key span read ${JSON.stringify(keyMatch.keyText)}, expected ${JSON.stringify(keyedIssueKey)}`,
  );
  assert(
    keyMatch.optionBox !== null &&
      keyMatch.optionBox.width > 0 &&
      keyMatch.optionBox.height > 0,
    `palette issue option for ${keyedIssueKey} is not visible (${JSON.stringify(keyMatch.optionBox)})`,
  );
  assert(
    keyMatch.keyBox !== null &&
      keyMatch.keyBox.width > 0 &&
      keyMatch.keyBox.height > 0,
    `palette key span for ${keyedIssueKey} is not visible (${JSON.stringify(keyMatch.keyBox)})`,
  );
  await tabA.pressKey(ESCAPE_KEY);
  await waitForSelectorGone(tabA, PALETTE, 5000);

  // LAS-154 regression: keyboard navigation must scroll the active row into
  // view instead of leaving it clipped below the listbox.
  state.phase = "palette keyboard scroll";
  await tabA.pressKey(CTRL_K);
  await tabA.waitFor(PALETTE_RESULTS, 5000);
  // Focusing the input keeps ArrowDown on the palette's handler, and an empty
  // query keeps every seeded issue listed.
  await tabA.setValue(PALETTE_INPUT, "");
  const seededOptions = await waitForIssueOptions(tabA, (count) => count >= 10, 3000);
  const seededIssueCount = seededOptions?.issueOptionIds?.length ?? 0;
  assert(
    seededOptions !== null && seededOptions.list === true && seededIssueCount >= 10,
    `palette listed ${seededIssueCount} issue options after clearing the query; the seeded backlog issues are missing`,
  );
  const optionCount = await tabA.count(PALETTE_OPTION);
  assert(
    optionCount > seededIssueCount,
    `palette listed ${optionCount} options but ${seededIssueCount} of them are issues; the action rows are missing`,
  );
  for (let index = 1; index < optionCount; index += 1) {
    await tabA.pressKey(ARROW_DOWN);
  }
  const scrollSnapshot = await waitForPaletteScroll(tabA, 2000);
  const rowBottomGap =
    scrollSnapshot !== null &&
    Number.isFinite(scrollSnapshot.listBottom) &&
    Number.isFinite(scrollSnapshot.rowBottom)
      ? scrollSnapshot.listBottom - scrollSnapshot.rowBottom
      : null;
  state.palette = [
    ...(state.palette ?? []),
    `keyboard scroll after ${optionCount - 1} ArrowDown -> ${JSON.stringify(scrollSnapshot)} (bottom gap ${rowBottomGap === null ? "unknown" : `${rowBottomGap.toFixed(1)}px`})`,
  ];
  assert(
    scrollSnapshot !== null && scrollSnapshot.list === true,
    `palette results listbox ${PALETTE_RESULTS} was not found during the scroll check`,
  );
  assert(
    scrollSnapshot.selectedId !== null,
    "palette has no aria-selected option after keyboard navigation",
  );
  assert(
    scrollSnapshot.selectedId === scrollSnapshot.activeDescendant,
    `selected option ${JSON.stringify(scrollSnapshot.selectedId)} does not match aria-activedescendant ${JSON.stringify(scrollSnapshot.activeDescendant)}`,
  );
  assert(
    scrollSnapshot.selectedId === scrollSnapshot.lastOptionId,
    `ArrowDown stopped on ${JSON.stringify(scrollSnapshot.selectedId)}, expected the last option ${JSON.stringify(scrollSnapshot.lastOptionId)}`,
  );
  assert(
    scrollSnapshot.scrollHeight > scrollSnapshot.clientHeight,
    `palette listbox does not overflow (scrollHeight ${scrollSnapshot.scrollHeight} <= clientHeight ${scrollSnapshot.clientHeight}); the seeded issues are not being listed`,
  );
  assert(
    scrollSnapshot.scrollTop > 0,
    `palette listbox never scrolled while the last option was selected (scrollTop ${scrollSnapshot.scrollTop}, scrollHeight ${scrollSnapshot.scrollHeight}, clientHeight ${scrollSnapshot.clientHeight})`,
  );
  assert(
    scrollSnapshot.rowTop !== null &&
      scrollSnapshot.rowBottom !== null &&
      scrollSnapshot.rowTop >= scrollSnapshot.listTop - 0.5 &&
      scrollSnapshot.rowBottom <= scrollSnapshot.listBottom + 0.5,
    `selected option ${JSON.stringify(scrollSnapshot.selectedId)} is outside the listbox: row ${scrollSnapshot.rowTop}-${scrollSnapshot.rowBottom}, list ${scrollSnapshot.listTop}-${scrollSnapshot.listBottom}`,
  );
  // The listbox overflows here, so the last row must sit clear of the bottom
  // edge: a flush row means the scroll padding regressed away.
  assert(
    rowBottomGap !== null && rowBottomGap >= PALETTE_BOTTOM_GUTTER_PX,
    `selected option ${JSON.stringify(scrollSnapshot.selectedId)} is flush against the listbox bottom: gap ${rowBottomGap === null ? "unknown" : `${rowBottomGap.toFixed(1)}px`} is under the ${PALETTE_BOTTOM_GUTTER_PX}px gutter (row bottom ${scrollSnapshot.rowBottom}, list bottom ${scrollSnapshot.listBottom})`,
  );
  state.phase = "screenshot palette";
  await sleep(150);
  const screenshotPaletteBytes = await tabA.screenshot(SCREENSHOT_PALETTE);
  await tabA.pressKey(ESCAPE_KEY);
  await waitForSelectorGone(tabA, PALETTE, 5000);

  state.phase = "open command palette";
  await tabA.pressKey(CTRL_K);
  await tabA.waitFor(PALETTE, 5000);
  await tabA.setValue(PALETTE_INPUT, "new issue");
  await tabA.waitFor("#palette-new-issue", 5000);
  await tabA.pressKey(ENTER_KEY);
  await tabA.waitFor(NEW_ISSUE_TITLE, 10_000);

  state.phase = "create issue";
  await tabA.setValue(NEW_ISSUE_TITLE, "Browser acceptance task");
  await tabA.waitFor(NEW_ISSUE_BLOCKED_BY, 10_000);
  const creationBlockerKey = String(
    await tabA.evaluate(
      `(() => {
        const select = document.querySelector(${JSON.stringify(NEW_ISSUE_BLOCKED_BY)});
        if (select === null || select.options.length === 0) {
          return "";
        }
        const value = select.options[0].value;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return value;
      })()`,
    ),
  );
  assert(
    creationBlockerKey.length > 0,
    "new issue dialog offers no blocked-by candidate; the seeded backlog fillers are missing",
  );
  // CRV-3: the dialog's Parent select offers the project's issues; pick the
  // first real candidate so the created issue lands as a child.
  await tabA.waitFor(NEW_ISSUE_PARENT, 10_000);
  const creationParentKey = String(
    await tabA.evaluate(
      `(() => {
        const select = document.querySelector(${JSON.stringify(NEW_ISSUE_PARENT)});
        if (select === null) {
          return "";
        }
        const option = Array.from(select.options).find(
          (candidate) => candidate.value.length > 0,
        );
        if (option === undefined) {
          return "";
        }
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return option.value;
      })()`,
    ),
  );
  assert(
    creationParentKey.length > 0,
    "new issue dialog offers no parent candidate; the seeded issues are missing",
  );
  await tabA.click(NEW_ISSUE_SUBMIT);
  await tabA.waitFor('[data-testid="toast"]', 5000);
  await tabA.waitFor(ISSUE_DETAIL, 15_000);
  await tabA.waitFor(RELATION_BLOCKED_BY_ROW, 10_000);
  const createdBlockedByText = String(
    await tabA.text(RELATION_BLOCKED_BY_ROW),
  );
  assert(
    createdBlockedByText.includes(creationBlockerKey),
    `create-time blocked-by row ${JSON.stringify(createdBlockedByText)} omits ${creationBlockerKey}`,
  );
  await tabA.waitFor(ISSUE_PARENT_ROW, 10_000);
  const parentRowDeadline = Date.now() + 10_000;
  let createdParentText = "";
  for (;;) {
    createdParentText = String(await tabA.text(ISSUE_PARENT_ROW));
    if (createdParentText.includes(creationParentKey)) {
      break;
    }
    assert(
      Date.now() < parentRowDeadline,
      `created issue parent row ${JSON.stringify(createdParentText)} omits ${creationParentKey}`,
    );
    await sleep(50);
  }

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

  state.phase = "add block through relations dialog";
  await tabA.click(EDIT_RELATIONS);
  await tabA.waitFor(RELATION_DIALOG, 10_000);
  const addedBlockKey = String(
    await tabA.evaluate(
      `(() => {
        const select = document.querySelector(${JSON.stringify(RELATION_BLOCKS)});
        if (select === null) {
          return "";
        }
        const option = Array.from(select.options).find(
          (candidate) =>
            candidate.value.length > 0 &&
            candidate.value !== ${JSON.stringify(creationBlockerKey)} &&
            candidate.value !== ${JSON.stringify(issueKey)},
        );
        if (option === undefined) {
          return "";
        }
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return option.value;
      })()`,
    ),
  );
  assert(
    addedBlockKey.length > 0,
    `relations dialog offers no block candidate besides ${creationBlockerKey} and ${issueKey}`,
  );
  await tabA.click(RELATION_SAVE);
  await waitForSelectorGone(tabA, RELATION_DIALOG, 10_000);
  // The row can render before the post-save refetch lands, so poll until its
  // text names the added key instead of reading one transient render.
  const addDeadline = Date.now() + 10_000;
  let blocksRowText = "";
  for (;;) {
    blocksRowText =
      (await tabA.count(RELATION_BLOCKS_ROW)) === 0
        ? ""
        : String(await tabA.text(RELATION_BLOCKS_ROW));
    if (blocksRowText.includes(addedBlockKey)) {
      break;
    }
    assert(
      Date.now() < addDeadline,
      `blocks row ${JSON.stringify(blocksRowText)} omits added block ${addedBlockKey}`,
    );
    await sleep(50);
  }

  state.phase = "remove blocker through relations dialog";
  await tabA.click(EDIT_RELATIONS);
  await tabA.waitFor(RELATION_DIALOG, 10_000);
  await tabA.evaluate(
    `(() => {
      const select = document.querySelector(${JSON.stringify(RELATION_BLOCKED_BY)});
      if (select === null) {
        return false;
      }
      for (const option of select.options) {
        option.selected = false;
      }
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
  );
  await tabA.click(RELATION_SAVE);
  await waitForSelectorGone(tabA, RELATION_DIALOG, 10_000);
  // The row unmounts when the last blocker goes away, so an absent row is the
  // expected shape; poll until either the row is gone or its text no longer
  // names the removed key so a stale render cannot pass the assertion.
  const removalDeadline = Date.now() + 10_000;
  let remainingBlockedBy = "";
  for (;;) {
    remainingBlockedBy =
      (await tabA.count(RELATION_BLOCKED_BY_ROW)) === 0
        ? ""
        : String(await tabA.text(RELATION_BLOCKED_BY_ROW));
    if (!remainingBlockedBy.includes(creationBlockerKey)) {
      break;
    }
    assert(
      Date.now() < removalDeadline,
      `blocked-by row still names ${creationBlockerKey} after saving the emptied selection (${JSON.stringify(remainingBlockedBy)})`,
    );
    await sleep(50);
  }

  state.phase = "screenshot issue detail";
  await sleep(200);
  const screenshotDetailBytes = await tabA.screenshot(SCREENSHOT_DETAIL);

  state.phase = "open second tab";
  const tabBSession = await openTab(
    state.cdp,
    "B",
    `${baseUrl}${issuePath}`,
  );
  // Creating a target does not make it the focused tab: headless Chromium
  // leaves focus on the previously active page, so the new tab can stall
  // hydration and never open its realtime EventSource. Activate the target,
  // push it to the front, and re-assert focus emulation before asserting.
  await state.cdp.send("Target.activateTarget", {
    targetId: tabBSession.targetId,
  });
  await state.cdp.send("Page.bringToFront", {}, tabBSession.sessionId);
  await tabBSession.waitFor(ISSUE_DETAIL, 20_000);
  await state.cdp.send(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    tabBSession.sessionId,
  );
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

  // CRV-3: the child names its parent, and following that link shows the
  // child on the parent's hierarchy row. The passkey phase reloads the board
  // next, so it does not depend on where this leaves tab A.
  state.phase = "open parent from hierarchy";
  await tabA.click(`${ISSUE_PARENT_ROW} button`);
  await tabA.waitFor(ISSUE_CHILDREN_ROW, 10_000);
  const childrenRowDeadline = Date.now() + 10_000;
  let createdChildrenText = "";
  for (;;) {
    createdChildrenText = String(await tabA.text(ISSUE_CHILDREN_ROW));
    if (createdChildrenText.includes(issueKey)) {
      break;
    }
    assert(
      Date.now() < childrenRowDeadline,
      `parent children row ${JSON.stringify(createdChildrenText)} omits ${issueKey}`,
    );
    await sleep(50);
  }

  // Passkey leg: register a credential through the CDP virtual authenticator,
  // sign out, then sign back in without the UI token. The board is reloaded
  // first so the path asserted after sign-in is the board itself.
  state.phase = "register passkey";
  const passkeyNickname = "Acceptance passkey";
  await tabA.navigate(boardUrl);
  await tabA.waitFor(STATUS_TAB, 20_000);
  await state.cdp.send(
    "Page.bringToFront",
    {},
    tabA.sessionId,
  );
  await tabA.click(PASSKEYS_OPEN);
  await tabA.waitFor(PASSKEY_NICKNAME, 10_000);
  const addButtonRect = await waitForStableBox(tabA, PASSKEY_ADD);
  // The virtual authenticator created during setup outlives this navigation,
  // so the only thing to restore is page focus: headless WebAuthn waits for
  // the page to be focused before it resolves the ceremony.
  await state.cdp.send("Page.bringToFront", {}, tabA.sessionId);
  await state.cdp.send(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    tabA.sessionId,
  );
  await tabA.setValue(PASSKEY_NICKNAME, passkeyNickname);
  await tabA.click(PASSKEY_ADD);
  const addOutcome = await waitForPasskeyAddOutcome(tabA, 2000);
  const addRect = addOutcome.addRect ?? addButtonRect;
  if (!addOutcome.row && addOutcome.error !== null) {
    throw new Error(
      `passkey add failed: ${JSON.stringify(addOutcome.error)} (add button rect: ${JSON.stringify(addRect)})`,
    );
  }
  if (!addOutcome.row && !addOutcome.dialog) {
    throw new Error(
      `passkeys dialog closed after the add click (likely a backdrop click); add button rect: ${JSON.stringify(addRect)}; page at ${JSON.stringify(addOutcome.path)}${addOutcome.signInForm ? " (sign-in form rendered)" : ""}`,
    );
  }
  try {
    await tabA.waitFor(PASSKEY_ROW, 20_000);
  } catch (error) {
    const late = await readPasskeyAddState(tabA);
    throw new Error(
      `passkey row never appeared (${describeError(error)}); dialog ${late.dialog ? "still open" : "closed"}, inline error ${JSON.stringify(late.error)}, page at ${JSON.stringify(late.path)}${late.signInForm ? " (sign-in form rendered)" : ""}; disabled=${JSON.stringify(late.disabled)}, loading=${JSON.stringify(late.loading)}, toasts=${JSON.stringify(late.toasts)}, dialogTail=${JSON.stringify(late.dialogTail)}`,
    );
  }
  const passkeyRows = await tabA.count(PASSKEY_ROW);
  const passkeyRowText = await tabA.text(PASSKEY_ROW);
  assert(
    passkeyRowText.includes(passkeyNickname),
    `passkey row read ${JSON.stringify(passkeyRowText)}, expected it to name ${JSON.stringify(passkeyNickname)}`,
  );
  await tabA.pressKey(ESCAPE_KEY);
  await waitForSelectorGone(tabA, PASSKEY_ROW, 5000);

  state.phase = "sign out";
  await tabA.pressKey(CTRL_K);
  await tabA.waitFor(PALETTE, 5000);
  await tabA.setValue(PALETTE_INPUT, "sign out");
  await tabA.waitFor("#palette-sign-out", 5000);
  await tabA.pressKey(ENTER_KEY);
  await tabA.waitFor(SIGNIN_PASSKEY, 15_000);

  state.phase = "passkey sign-in";
  await tabA.click(SIGNIN_PASSKEY);
  await tabA.waitFor(STATUS_TAB, 20_000);
  const passkeyPath = String(await tabA.evaluate("window.location.pathname"));
  const boardPath = `/p/${encodeURIComponent(projectKey)}`;
  assert(
    passkeyPath === boardPath,
    `after passkey sign-in the page was at ${JSON.stringify(passkeyPath)}, expected the board at ${JSON.stringify(boardPath)}`,
  );

  const summary = STATUSES.map((status) => `${status}=${counts.get(status)}`).join(
    " ",
  );
  const lines = [
    `PASS browser: signed in and loaded ${boardUrl} at ${viewport.width}x${viewport.height}`,
    `PASS browser: 5 status tabs visible (${summary}); tab bar ${Math.round(barRect.width)}x${Math.round(barRect.height)}px`,
    `PASS browser: board screenshot ${SCREENSHOT_BOARD} (${screenshotBoardBytes} bytes)`,
    `PASS browser: projects page fits ${projectsLayout.innerWidth}px with no horizontal overflow (scrollWidth ${projectsLayout.scrollWidth}); 5 mobile nav cells span ${Math.round(navCellsWidth)}px (${projectsLayout.cells.map((cell) => `${cell.label || "?"} ${Math.round(cell.width)}px`).join(", ")})`,
    `PASS browser: projects screenshot ${SCREENSHOT_PROJECTS} (${screenshotProjectsBytes} bytes)`,
    `PASS browser: project created WEB at /p/WEB/overview with "0%" progress (${JSON.stringify(projectProgressText)}) and body showing "Web project"`,
    `PASS browser: project overview screenshot ${SCREENSHOT_PROJECT_OVERVIEW} (${screenshotProjectOverviewBytes} bytes)`,
    `PASS browser: project status edit set in_progress; overview shows the In progress chip (rendered uppercase) (dialog screenshot ${SCREENSHOT_PROJECT_DIALOG} (${screenshotProjectDialogBytes} bytes))`,
    `PASS browser: project card WEB ${Math.round(projectCard.width)}x${Math.round(projectCard.height)}px at ${Math.round(projectCard.left)}-${Math.round(projectCard.right)} inside the ${projectCard.innerWidth}px viewport with "WEB", "Web project" and "0/0" progress; ${projectCard.projectCount} project${projectCard.projectCount === 1 ? "" : "s"} shown (no horizontal overflow, screenshot ${SCREENSHOT_PROJECTS_CARD} (${screenshotProjectsCardBytes} bytes))`,
    `PASS browser: palette key search ${JSON.stringify(keyedFragment)} matched ${keyMatch.issueOptionIds.length} issue option with key ${JSON.stringify(keyMatch.keyText)} (option ${Math.round(keyMatch.optionBox.width)}x${Math.round(keyMatch.optionBox.height)}px, key span ${Math.round(keyMatch.keyBox.width)}x${Math.round(keyMatch.keyBox.height)}px)`,
    `PASS browser: palette ArrowDown x${scrollSnapshot.optionCount - 1} of ${scrollSnapshot.optionCount} options selected ${scrollSnapshot.selectedId} in a ${scrollSnapshot.clientHeight}px listbox holding ${scrollSnapshot.scrollHeight}px, scrollTop ${Math.round(scrollSnapshot.scrollTop)}, row ${Math.round(scrollSnapshot.rowTop)}-${Math.round(scrollSnapshot.rowBottom)} inside ${Math.round(scrollSnapshot.listTop)}-${Math.round(scrollSnapshot.listBottom)} with a ${rowBottomGap.toFixed(1)}px bottom gutter (min ${PALETTE_BOTTOM_GUTTER_PX}px)`,
    `PASS browser: palette screenshot ${SCREENSHOT_PALETTE} (${screenshotPaletteBytes} bytes)`,
    `PASS browser: command palette + new issue dialog created ${issueKey} at ${issuePath} (toast shown)`,
    `PASS browser: create modal relation ${creationBlockerKey} rendered on ${issueKey}`,
    `PASS browser: relations modal added ${addedBlockKey} as a block`,
    `PASS browser: relations modal removed ${creationBlockerKey}`,
    `PASS browser: detail screenshot ${SCREENSHOT_DETAIL} (${screenshotDetailBytes} bytes)`,
    `PASS browser: second tab opened ${issuePath} with ${eventsB} timeline event(s)`,
    `PASS browser: comment propagated tab A -> tab B in ${elapsedMs}ms (< ${COMMENT_LATENCY_LIMIT_MS}ms; marker ${JSON.stringify(marker)}; tab A timeline events ${eventsA})`,
    `PASS browser: second-tab screenshot ${SCREENSHOT_SECOND_TAB} (${screenshotBBytes} bytes)`,
    `PASS browser: created issue ${issueKey} parent row names ${creationParentKey} (${JSON.stringify(createdParentText.trim())})`,
    `PASS browser: parent ${creationParentKey} children row lists ${issueKey} (${JSON.stringify(createdChildrenText.trim())})`,
    `PASS browser: passkey registered as ${JSON.stringify(passkeyNickname)} through virtual authenticator ${authenticatorId} (${passkeyRows} passkey row(s) in the dialog)`,
    `PASS browser: passkey sign-in reached the board at ${passkeyPath}`,
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
