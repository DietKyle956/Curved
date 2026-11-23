import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SERVER_ENTRY = join(REPO_ROOT, "src", "composition", "server.ts");
const EXIT_DEADLINE_MS = 10_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runServer(cwd: string): Promise<RunResult> {
  const { promise, resolve: settle, reject } =
    Promise.withResolvers<RunResult>();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd,
    env: {
      ...process.env,
      CURVED_UI_TOKEN: "",
      DATABASE_URL: "postgres://curved:curved@127.0.0.1:1/curved",
      CURVED_DOMAIN: "",
      CURVED_WEBAUTHN_ORIGINS: "",
      CURVED_WEBAUTHN_RP_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = child.stdout;
  const err = child.stderr;
  if (out === null || err === null) {
    reject(new Error("spawned server entrypoint without piped stdio"));
    return promise;
  }
  let stdout = "";
  let stderr = "";
  out.setEncoding("utf8");
  err.setEncoding("utf8");
  out.on("data", (chunk: string) => {
    stdout += chunk;
  });
  err.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Watchdog on a real child process lifetime, not a sleep guessing at a
  // race: fake timers cannot advance an OS process, and `close` is the
  // awaited signal. The timer only kills a regressed guard before the run hangs.
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(
      new Error(
        `server entrypoint did not exit within ${EXIT_DEADLINE_MS}ms; ` +
          `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      ),
    );
  }, EXIT_DEADLINE_MS);

  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    settle({ code, stdout, stderr });
  });
  return promise;
}

test(
  "the server entrypoint exits 1 with a visible error when CURVED_UI_TOKEN is empty",
  { timeout: EXIT_DEADLINE_MS + 5_000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "curved-server-entry-"));
    try {
      const result = await runServer(cwd);
      assert.equal(result.code, 1, result.stderr);
      assert.match(
        result.stderr,
        /CURVED_UI_TOKEN is required to start the HTTP server/,
      );
      assert.doesNotMatch(result.stdout, /curved listening/);
      // Proves the process died before touching Postgres.
      assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
