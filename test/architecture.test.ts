import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const REPO_ROOT = resolvePath(import.meta.dirname, "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-architecture.mjs");

type RunResult = { code: number | null; stdout: string; stderr: string };

// Passing a null root runs the checker the way `npm run check` does: from the
// repository root, with the default root derived from the script location.
function runChecker(root: string | null): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const args =
    root === null
      ? [join("scripts", "check-architecture.mjs")]
      : [CHECKER, "--root", root];
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

async function withFixture(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "curved-arch-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the repository follows the import-direction rules", async () => {
  const result = await runChecker(null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /architecture: ok/);
});

test("application code may not import an adapter", async () => {
  await withFixture(
    {
      "src/application/bad.ts":
        'import { createPorts } from "../adapters/postgres/ports.ts";\n',
      "src/adapters/postgres/ports.ts":
        "export const createPorts = () => ({});\n",
    },
    async (root) => {
      const result = await runChecker(root);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /application/);
      assert.match(result.stderr, /src\/application\/bad\.ts/);
    },
  );
});

test("domain code may not import pg", async () => {
  await withFixture(
    {
      "src/domain/bad.ts": 'import pg from "pg";\n',
    },
    async (root) => {
      const result = await runChecker(root);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /src\/domain\/bad\.ts/);
      assert.match(result.stderr, /pg/);
    },
  );
});

test("web ui code may not import an adapter", async () => {
  await withFixture(
    {
      "web/src/ui/bad.ts":
        'import { api } from "../adapters/api-client.ts";\n',
      "web/src/adapters/api-client.ts": "export const api = {};\n",
    },
    async (root) => {
      const result = await runChecker(root);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /web\/src\/ui\/bad\.ts/);
    },
  );
});

test("web code may only import the backend status contract", async () => {
  await withFixture(
    {
      "web/src/lib/bad.ts":
        'import type { Ports } from "../../../src/application/ports.ts";\n',
    },
    async (root) => {
      const result = await runChecker(root);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /web\/src\/lib\/bad\.ts/);
      assert.match(result.stderr, /web-backend-import/);
    },
  );
});
