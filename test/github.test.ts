import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createApp } from "../src/http/app.ts";
import { issueKeyFromText, branchNameForIssue } from "../src/domain/keys.ts";
import type { Issue, IssueEvent } from "../src/domain/types.ts";
import { createAgent } from "../src/services/agents.ts";
import { applyPullRequestEvent } from "../src/services/github.ts";
import {
  createIssue,
  getIssue,
  getIssueTimeline,
} from "../src/application/issues.ts";
import { createProject } from "../src/application/projects.ts";
import { claimNext } from "../src/services/queue.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

const SECRET = "test-webhook-secret";
const UI_TOKEN = "test-ui-token";
const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "route not found" },
} as const;

interface HttpApp {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface WebhookResponse {
  ok: boolean;
  ignored?: boolean;
}

let testDb: TestDatabase;
let app: HttpApp;
const openedApps: HttpApp[] = [];

before(async () => {
  testDb = await openTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
  app = createTestApp();
});

afterEach(async () => {
  const pending = openedApps.splice(0);
  await Promise.all(pending.map((created) => created.close()));
});

after(async () => {
  await testDb.close();
});

function createTestApp(webhookSecret: string | null = SECRET): HttpApp {
  const created = createApp({
    db: testDb.db,
    ports: testDb.ports,
    databaseUrl: testDb.databaseUrl,
    uiToken: UI_TOKEN,
    logger: () => {},
    ...(webhookSecret === null ? {} : { webhookSecret }),
  });
  openedApps.push(created);
  return created;
}

function sign(rawBody: string, secret: string = SECRET): string {
  const digest = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

function request(
  target: HttpApp,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return target.handle(new Request(new URL(path, "http://localhost"), init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function postWebhook(
  target: HttpApp,
  payload: unknown,
  options: {
    event?: string;
    signature?: string | null;
    rawBody?: string;
  } = {},
): Promise<Response> {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("x-github-event", options.event ?? "pull_request");
  const signature =
    options.signature === undefined ? sign(rawBody) : options.signature;
  if (signature !== null) {
    headers.set("x-hub-signature-256", signature);
  }
  return request(target, "/webhooks/github", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

function pullRequestPayload(
  overrides: {
    action?: string;
    merged?: boolean;
    title?: string;
    headRef?: string | null;
    nestedActionOnly?: boolean;
  } = {},
): Record<string, unknown> {
  const action = overrides.action ?? "opened";
  const pullRequest: Record<string, unknown> = {
    number: 7,
    title: overrides.title ?? "TAC-1 support",
    merged: overrides.merged ?? false,
  };
  if (overrides.headRef !== null) {
    pullRequest.head = { ref: overrides.headRef ?? "TAC-1-support" };
  }
  // GitHub puts the action at the top level; the service also accepts the
  // nested pull_request.action shape, which this option exercises alone.
  if (overrides.nestedActionOnly === true) {
    pullRequest.action = action;
    return { pull_request: pullRequest };
  }
  return { action, number: 7, pull_request: pullRequest };
}

async function seedProject(): Promise<void> {
  await createProject(testDb.ports, { key: "TAC", name: "Tactics" });
}

async function seedIssue(status?: string, title = "Seed issue"): Promise<Issue> {
  await seedProject();
  return createIssue(testDb.ports, {
    project: "TAC",
    title,
    ...(status === undefined ? {} : { status }),
  });
}

async function issueStatus(key: string): Promise<string> {
  const issue = await getIssue(testDb.ports, key);
  return issue.status;
}

async function statusEvents(key: string): Promise<IssueEvent[]> {
  const { events } = await getIssueTimeline(testDb.ports, key);
  return events.filter((event) => event.kind === "status");
}

test("issueKeyFromText finds canonical keys and rejects non-matches", () => {
  const cases: Array<[string, string | null]> = [
    ["TAC-014-add-login", "TAC-14"],
    ["feature/TAC-7-fix", "TAC-7"],
    ["Add LAS-151 support", "LAS-151"],
    ["los-151", null],
    ["TAC-1234567", null],
    ["TAC-", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(issueKeyFromText(input), expected, input);
  }
});

test("branchNameForIssue canonicalizes padded keys and slugs titles", () => {
  assert.equal(
    branchNameForIssue("TAC-0007", "Fix Login: Fast!"),
    "TAC-7-fix-login-fast",
  );
  assert.equal(branchNameForIssue("TAC-1", ""), "TAC-1");
  assert.equal(branchNameForIssue("TAC-1", "  ???  "), "TAC-1");
});

test("branchNameForIssue caps the slug at 60 characters without a trailing dash", () => {
  assert.equal(
    branchNameForIssue("TAC-2", "a".repeat(70)),
    `TAC-2-${"a".repeat(60)}`,
  );
  assert.equal(
    branchNameForIssue("TAC-2", `${"a".repeat(59)} tail`),
    `TAC-2-${"a".repeat(59)}`,
  );
});

test("a missing webhook secret returns 503 and leaves the issue untouched", async () => {
  await seedIssue("in_progress");
  const bare = createTestApp(null);
  const empty = createTestApp("");

  for (const target of [bare, empty]) {
    const response = await postWebhook(target, pullRequestPayload());
    assert.equal(response.status, 503);
    assert.equal(
      (await readJson<ErrorResponse>(response)).error.code,
      "webhook_not_configured",
    );
  }
  assert.equal(await issueStatus("TAC-1"), "in_progress");
  assert.equal((await statusEvents("TAC-1")).length, 0);
});

test("a wrong or missing signature returns 401 and leaves the issue untouched", async () => {
  await seedIssue("in_progress");
  const rawBody = JSON.stringify(pullRequestPayload());

  const wrong = await postWebhook(app, pullRequestPayload(), {
    rawBody,
    signature: sign(rawBody, "wrong-secret"),
  });
  assert.equal(wrong.status, 401);
  assert.equal(
    (await readJson<ErrorResponse>(wrong)).error.code,
    "not_authenticated",
  );

  const missing = await postWebhook(app, pullRequestPayload(), {
    rawBody,
    signature: null,
  });
  assert.equal(missing.status, 401);
  assert.equal(
    (await readJson<ErrorResponse>(missing)).error.code,
    "not_authenticated",
  );

  assert.equal(await issueStatus("TAC-1"), "in_progress");
  assert.equal((await statusEvents("TAC-1")).length, 0);
});

test("an opened pull request moves an in-progress issue to in review", async () => {
  await seedIssue("in_progress");

  const response = await postWebhook(app, pullRequestPayload());

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), { ok: true });
  assert.equal(await issueStatus("TAC-1"), "in_review");
  const events = await statusEvents("TAC-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actorType, "git");
  assert.equal(events[0]?.fromStatus, "in_progress");
  assert.equal(events[0]?.toStatus, "in_review");
  assert.equal(events[0]?.body, "pull request #7 opened");
});

test("the nested pull_request.action shape is accepted as a fallback", async () => {
  await seedIssue("in_progress");

  const response = await postWebhook(
    app,
    pullRequestPayload({ nestedActionOnly: true }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), { ok: true });
  assert.equal(await issueStatus("TAC-1"), "in_review");
  const events = await statusEvents("TAC-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.body, "pull request #7 opened");
});

test("replaying the same delivery is ignored without adding an event", async () => {
  await seedIssue("in_progress");
  const payload = pullRequestPayload();

  const first = await postWebhook(app, payload);
  assert.equal(first.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(first), { ok: true });

  const replay = await postWebhook(app, payload);
  assert.equal(replay.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(replay), {
    ok: true,
    ignored: true,
  });
  assert.equal((await statusEvents("TAC-1")).length, 1);
});

test("a merged closed pull request moves a reviewing issue to done", async () => {
  await seedIssue("in_review");

  const payload = {
    action: "closed",
    number: 7,
    pull_request: {
      number: 7,
      title: "TAC-1 support",
      merged: true,
      head: { ref: "TAC-1-support" },
    },
  };
  const response = await postWebhook(app, payload);

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), { ok: true });
  assert.equal(await issueStatus("TAC-1"), "done");
  const events = await statusEvents("TAC-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.fromStatus, "in_review");
  assert.equal(events[0]?.toStatus, "done");
  assert.equal(events[0]?.body, "pull request #7 closed");
});

test("an unmerged closed pull request is ignored", async () => {
  await seedIssue("in_review");

  const response = await postWebhook(
    app,
    pullRequestPayload({ action: "closed", merged: false }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), {
    ok: true,
    ignored: true,
  });
  assert.equal(await issueStatus("TAC-1"), "in_review");
  assert.equal((await statusEvents("TAC-1")).length, 0);
});

test("an opened pull request does not move a todo issue", async () => {
  await seedIssue("todo");

  const response = await postWebhook(app, pullRequestPayload());

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), {
    ok: true,
    ignored: true,
  });
  assert.equal(await issueStatus("TAC-1"), "todo");
});

test("an unknown issue key is ignored", async () => {
  await seedIssue("in_progress");

  const response = await postWebhook(
    app,
    pullRequestPayload({ headRef: null, title: "Add TAC-999 support" }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), {
    ok: true,
    ignored: true,
  });
  assert.equal(await issueStatus("TAC-1"), "in_progress");
});

test("a non pull_request event is ignored", async () => {
  await seedIssue("in_progress");

  const response = await postWebhook(
    app,
    { ref: "refs/heads/TAC-1-add-support" },
    { event: "push" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), {
    ok: true,
    ignored: true,
  });
  assert.equal(await issueStatus("TAC-1"), "in_progress");
});

test("the head ref key wins over a title naming another issue", async () => {
  await seedProject();
  await createIssue(testDb.ports, {
    project: "TAC",
    title: "First",
    status: "in_progress",
  });
  await createIssue(testDb.ports, {
    project: "TAC",
    title: "Second",
    status: "in_progress",
  });

  const response = await postWebhook(
    app,
    pullRequestPayload({ headRef: "TAC-1-first", title: "Add TAC-2 support" }),
  );

  assert.equal(response.status, 200);
  assert.equal(await issueStatus("TAC-1"), "in_review");
  assert.equal(await issueStatus("TAC-2"), "in_progress");
});

test("the title supplies the key when the head ref is absent", async () => {
  await seedIssue("in_progress");

  const response = await postWebhook(
    app,
    pullRequestPayload({ headRef: null, title: "Add TAC-1 support" }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson<WebhookResponse>(response), { ok: true });
  assert.equal(await issueStatus("TAC-1"), "in_review");
});

test("an agent-claimed issue keeps its claim after the webhook moves it", async () => {
  await seedIssue("todo");
  await createAgent(testDb.db, "agent-1");
  const claimed = await claimNext(testDb.db, { project: "TAC" }, "agent-1");
  assert.equal(claimed.claimedBy, "agent-1");

  const response = await postWebhook(app, pullRequestPayload());

  assert.equal(response.status, 200);
  const issue = await getIssue(testDb.ports, "TAC-1");
  assert.equal(issue.status, "in_review");
  assert.equal(issue.claimedBy, "agent-1");
});

test("a malformed body with a valid signature returns 400 before any move", async () => {
  await seedIssue("in_progress");
  const rawBody = "{not json";

  const response = await postWebhook(app, null, { rawBody });

  assert.equal(response.status, 400);
  assert.equal(
    (await readJson<ErrorResponse>(response)).error.code,
    "validation",
  );
  assert.equal(await issueStatus("TAC-1"), "in_progress");
  assert.equal((await statusEvents("TAC-1")).length, 0);
});

test("a non-POST webhook request returns the route not found body", async () => {
  const response = await request(app, "/webhooks/github");

  assert.equal(response.status, 404);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/json/,
  );
  assert.deepEqual(await readJson(response), NOT_FOUND_BODY);
});

test("applyPullRequestEvent ignores payloads without a pull_request object", async () => {
  await seedIssue("in_progress");

  for (const payload of [null, [], { pull_request: null }, { pull_request: 5 }]) {
    assert.equal(
      await applyPullRequestEvent(testDb.ports, "pull_request", payload),
      null,
    );
  }
  assert.equal(await issueStatus("TAC-1"), "in_progress");
});
