import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createApp } from "../src/http/app.ts";
import { createAgent } from "../src/services/agents.ts";
import type { IssueEvent } from "../src/services/events.ts";
import { createIssue } from "../src/services/issues.ts";
import type { Issue } from "../src/services/issues.ts";
import { createProject } from "../src/services/projects.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

const UI_TOKEN = "test-ui-token";
const SESSION_COOKIE_VALUE = createHash("sha256")
  .update(UI_TOKEN, "utf8")
  .digest("hex");
const HUMAN_COOKIE = `curved_session=${SESSION_COOKIE_VALUE}`;
const JSON_HEADERS = { "content-type": "application/json" };
const HUMAN_BEARER = { authorization: `Bearer ${UI_TOKEN}` };
const COOKIE_HEADER = { cookie: HUMAN_COOKIE };

interface HttpApp {
  handle(request: Request): Promise<Response>;
}

interface Actor {
  type: "human" | "agent";
  name: string | null;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface MeResponse {
  actor: Actor;
}

interface IssueResponse {
  issue: Issue;
}

interface IssuesResponse {
  issues: Issue[];
}

interface IssueTimelineResponse {
  issue: Issue;
  events: IssueEvent[];
}

interface EventResponse {
  event: IssueEvent;
}

interface ProjectsResponse {
  projects: Array<{ id: number; key: string; name: string }>;
}

interface ProjectResponse {
  project: { id: number; key: string; name: string };
}

interface ReadyResponse {
  ready: Issue[];
  busy: string | null;
}

let testDb: TestDatabase;
let app: HttpApp;

before(async () => {
  testDb = await openTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
  app = createApp({ db: testDb.db, uiToken: UI_TOKEN, logger: () => {} });
});

after(async () => {
  await testDb.close();
});

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

function assertJson(response: Response): void {
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
}

async function seedProject(): Promise<void> {
  await createProject(testDb.db, { key: "TAC", name: "Tactics" });
}

async function seedIssue(status?: string): Promise<Issue> {
  await seedProject();
  return createIssue(testDb.db, {
    project: "TAC",
    title: "Seed issue",
    ...(status === undefined ? {} : { status }),
  });
}

test("createApp rejects an empty ui token with a message naming CURVED_UI_TOKEN", () => {
  assert.throws(
    () => createApp({ db: testDb.db, uiToken: "", logger: () => {} }),
    /CURVED_UI_TOKEN/,
  );
});

test("unauthenticated API reads return 401 not_authenticated", async () => {
  const issues = await request(app, "/api/issues");
  assert.equal(issues.status, 401);
  assertJson(issues);
  assert.equal((await readJson<ErrorResponse>(issues)).error.code, "not_authenticated");

  const me = await request(app, "/api/me");
  assert.equal(me.status, 401);
  assertJson(me);
  assert.equal((await readJson<ErrorResponse>(me)).error.code, "not_authenticated");

  const projects = await request(app, "/api/projects");
  assert.equal(projects.status, 401);
  assertJson(projects);
  assert.equal(
    (await readJson<ErrorResponse>(projects)).error.code,
    "not_authenticated",
  );
});

test("session login sets the expected cookie and logout clears it", async () => {
  const wrong = await request(app, "/api/session", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: "wrong-token" }),
  });
  assert.equal(wrong.status, 401);
  assertJson(wrong);
  assert.equal((await readJson<ErrorResponse>(wrong)).error.code, "not_authenticated");
  assert.equal(wrong.headers.get("set-cookie"), null);

  const login = await request(app, "/api/session", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: UI_TOKEN }),
  });
  assert.equal(login.status, 200);
  assertJson(login);
  const loginBody = await readJson<MeResponse>(login);
  assert.deepEqual(loginBody.actor, { type: "human", name: null });

  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, new RegExp(`curved_session=${SESSION_COOKIE_VALUE}`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=2592000/);

  const me = await request(app, "/api/me", { headers: COOKIE_HEADER });
  assert.equal(me.status, 200);
  assert.deepEqual((await readJson<MeResponse>(me)).actor, {
    type: "human",
    name: null,
  });

  const logout = await request(app, "/api/session", {
    method: "DELETE",
    headers: COOKIE_HEADER,
  });
  assert.equal(logout.status, 204);
  const clearCookie = logout.headers.get("set-cookie");
  assert.ok(clearCookie);
  assert.match(clearCookie, /curved_session=/);
  assert.match(clearCookie, /Max-Age=0/i);

  // The cookie is stateless, so "after logout" means the cleared cookie is gone.
  const afterLogout = await request(app, "/api/me");
  assert.equal(afterLogout.status, 401);
  assert.equal(
    (await readJson<ErrorResponse>(afterLogout)).error.code,
    "not_authenticated",
  );
});

test("bearer tokens resolve humans and agents, and an invalid bearer wins over a cookie", async () => {
  const human = await request(app, "/api/me", { headers: HUMAN_BEARER });
  assert.equal(human.status, 200);
  assert.deepEqual((await readJson<MeResponse>(human)).actor, {
    type: "human",
    name: null,
  });

  const created = await createAgent(testDb.db, "agent-1");
  const agent = await request(app, "/api/me", {
    headers: { authorization: `Bearer ${created.token}` },
  });
  assert.equal(agent.status, 200);
  assert.deepEqual((await readJson<MeResponse>(agent)).actor, {
    type: "agent",
    name: "agent-1",
  });

  const invalid = await request(app, "/api/me", {
    headers: { ...COOKIE_HEADER, authorization: "Bearer not-a-real-token" },
  });
  assert.equal(invalid.status, 401);
  assertJson(invalid);
  assert.equal(
    (await readJson<ErrorResponse>(invalid)).error.code,
    "not_authenticated",
  );
});

test("projects list, create, human-only rule, and duplicate keys", async () => {
  await createProject(testDb.db, { key: "TAC", name: "Tactics" });

  const list = await request(app, "/api/projects", { headers: HUMAN_BEARER });
  assert.equal(list.status, 200);
  assertJson(list);
  const projects = await readJson<ProjectsResponse>(list);
  assert.deepEqual(
    projects.projects.map((project) => project.key),
    ["TAC"],
  );

  const created = await request(app, "/api/projects", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ key: "OPS", name: "Operations" }),
  });
  assert.equal(created.status, 201);
  assertJson(created);
  const project = (await readJson<ProjectResponse>(created)).project;
  assert.equal(project.key, "OPS");
  assert.equal(project.name, "Operations");

  const duplicate = await request(app, "/api/projects", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ key: "OPS", name: "Operations again" }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await readJson<ErrorResponse>(duplicate)).error.code, "duplicate");

  const agentCreated = await createAgent(testDb.db, "agent-1");
  const forbidden = await request(app, "/api/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentCreated.token}`,
      ...JSON_HEADERS,
    },
    body: JSON.stringify({ key: "AGT", name: "Agent project" }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (await readJson<ErrorResponse>(forbidden)).error.code,
    "forbidden_transition",
  );
});

test("issues create, list with filters, timeline read, and unknown keys", async () => {
  await seedProject();

  const created = await request(app, "/api/issues", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ project: "TAC", title: "First issue" }),
  });
  assert.equal(created.status, 201);
  assertJson(created);
  const issue = (await readJson<IssueResponse>(created)).issue;
  assert.equal(issue.key, "TAC-1");
  assert.equal(issue.status, "backlog");
  assert.ok(Array.isArray(issue.allowedTransitions));
  assert.ok(issue.allowedTransitions.includes("todo"));

  const second = await request(app, "/api/issues", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ project: "TAC", title: "Second issue", status: "todo" }),
  });
  assert.equal(second.status, 201);

  const all = await request(app, "/api/issues?project=TAC", {
    headers: HUMAN_BEARER,
  });
  assert.equal(all.status, 200);
  assert.equal((await readJson<IssuesResponse>(all)).issues.length, 2);

  const filtered = await request(app, "/api/issues?project=TAC&status=todo", {
    headers: HUMAN_BEARER,
  });
  assert.equal(filtered.status, 200);
  const filteredIssues = (await readJson<IssuesResponse>(filtered)).issues;
  assert.deepEqual(
    filteredIssues.map((entry) => entry.key),
    ["TAC-2"],
  );

  const badStatus = await request(app, "/api/issues?project=TAC&status=nope", {
    headers: HUMAN_BEARER,
  });
  assert.equal(badStatus.status, 400);
  assert.equal((await readJson<ErrorResponse>(badStatus)).error.code, "validation");

  const show = await request(app, "/api/issues/TAC-1", { headers: HUMAN_BEARER });
  assert.equal(show.status, 200);
  assertJson(show);
  const timeline = await readJson<IssueTimelineResponse>(show);
  assert.equal(timeline.issue.key, "TAC-1");
  assert.equal(timeline.events[0]?.kind, "created");
  assert.equal(timeline.events[0]?.actorType, "human");
  assert.equal(
    new Date(timeline.events[0]!.createdAt).toISOString(),
    timeline.events[0]!.createdAt,
  );

  const missing = await request(app, "/api/issues/ZZZ-1", {
    headers: HUMAN_BEARER,
  });
  assert.equal(missing.status, 404);
  assert.equal((await readJson<ErrorResponse>(missing)).error.code, "not_found");
});

test("PATCH updates an issue for humans and forbids agents", async () => {
  await seedIssue("todo");

  const patched = await request(app, "/api/issues/TAC-1", {
    method: "PATCH",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({
      title: "Renamed issue",
      description: "A longer description",
      priority: 1,
    }),
  });
  assert.equal(patched.status, 200);
  assertJson(patched);
  const issue = (await readJson<IssueResponse>(patched)).issue;
  assert.equal(issue.title, "Renamed issue");
  assert.equal(issue.description, "A longer description");
  assert.equal(issue.priority, 1);

  const created = await createAgent(testDb.db, "agent-1");
  const forbidden = await request(app, "/api/issues/TAC-1", {
    method: "PATCH",
    headers: { authorization: `Bearer ${created.token}`, ...JSON_HEADERS },
    body: JSON.stringify({ title: "Agent edit" }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (await readJson<ErrorResponse>(forbidden)).error.code,
    "forbidden_transition",
  );
});

test("transition moves an issue along legal edges and rejects illegal ones", async () => {
  await seedIssue("todo");

  const moved = await request(app, "/api/issues/TAC-1/transition", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ to: "in_progress" }),
  });
  assert.equal(moved.status, 200);
  assertJson(moved);
  const issue = (await readJson<IssueResponse>(moved)).issue;
  assert.equal(issue.status, "in_progress");

  const illegal = await request(app, "/api/issues/TAC-1/transition", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ to: "done" }),
  });
  assert.equal(illegal.status, 409);
  assert.equal(
    (await readJson<ErrorResponse>(illegal)).error.code,
    "illegal_transition",
  );
});

test("comments return a created event and reject empty bodies", async () => {
  await seedIssue("todo");

  const comment = await request(app, "/api/issues/TAC-1/comments", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ body: "  looks good  " }),
  });
  assert.equal(comment.status, 201);
  assertJson(comment);
  const event = (await readJson<EventResponse>(comment)).event;
  assert.equal(event.kind, "comment");
  assert.equal(event.actorType, "human");
  assert.equal(event.body, "looks good");

  const empty = await request(app, "/api/issues/TAC-1/comments", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ body: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await readJson<ErrorResponse>(empty)).error.code, "validation");
});

test("agent claim, busy, ready, release, block, and unblock flow", async () => {
  await seedIssue("todo");
  const created = await createAgent(testDb.db, "agent-1");
  const agent = { authorization: `Bearer ${created.token}` };

  const humanClaim = await request(app, "/api/claims/next?project=TAC", {
    method: "POST",
    headers: HUMAN_BEARER,
  });
  assert.equal(humanClaim.status, 403);
  assert.equal(
    (await readJson<ErrorResponse>(humanClaim)).error.code,
    "forbidden_transition",
  );

  const ready = await request(app, "/api/ready?project=TAC", { headers: agent });
  assert.equal(ready.status, 200);
  assertJson(ready);
  const queue = await readJson<ReadyResponse>(ready);
  assert.equal(queue.busy, null);
  assert.deepEqual(
    queue.ready.map((entry) => entry.key),
    ["TAC-1"],
  );

  const claim = await request(app, "/api/claims/next?project=TAC", {
    method: "POST",
    headers: agent,
  });
  assert.equal(claim.status, 201);
  assertJson(claim);
  const claimed = (await readJson<IssueResponse>(claim)).issue;
  assert.equal(claimed.key, "TAC-1");
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.claimedBy, "agent-1");

  const again = await request(app, "/api/claims/next?project=TAC", {
    method: "POST",
    headers: agent,
  });
  assert.equal(again.status, 409);
  assert.equal((await readJson<ErrorResponse>(again)).error.code, "agent_busy");

  const busy = await request(app, "/api/ready?project=TAC", { headers: agent });
  assert.equal(busy.status, 200);
  const busyQueue = await readJson<ReadyResponse>(busy);
  assert.equal(busyQueue.busy, "TAC-1");
  assert.equal(busyQueue.ready.length, 0);

  const released = await request(app, "/api/issues/TAC-1/release", {
    method: "POST",
    headers: agent,
  });
  assert.equal(released.status, 200);
  const releasedIssue = (await readJson<IssueResponse>(released)).issue;
  assert.equal(releasedIssue.status, "todo");
  assert.equal(releasedIssue.claimedBy, null);

  const reclaim = await request(app, "/api/claims/next?project=TAC", {
    method: "POST",
    headers: agent,
  });
  assert.equal(reclaim.status, 201);

  const blocked = await request(app, "/api/issues/TAC-1/block", {
    method: "POST",
    headers: { ...agent, ...JSON_HEADERS },
    body: JSON.stringify({ reason: "needs input" }),
  });
  assert.equal(blocked.status, 200);
  const blockedIssue = (await readJson<IssueResponse>(blocked)).issue;
  assert.equal(blockedIssue.status, "todo");
  assert.equal(blockedIssue.claimedBy, null);
  assert.equal(blockedIssue.blockedReason, "needs input");

  const agentUnblock = await request(app, "/api/issues/TAC-1/unblock", {
    method: "POST",
    headers: agent,
  });
  assert.equal(agentUnblock.status, 403);
  assert.equal(
    (await readJson<ErrorResponse>(agentUnblock)).error.code,
    "forbidden_transition",
  );

  const humanBlock = await request(app, "/api/issues/TAC-1/block", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ reason: "human cannot block" }),
  });
  assert.equal(humanBlock.status, 403);
  assert.equal(
    (await readJson<ErrorResponse>(humanBlock)).error.code,
    "forbidden_transition",
  );

  const humanUnblock = await request(app, "/api/issues/TAC-1/unblock", {
    method: "POST",
    headers: HUMAN_BEARER,
  });
  assert.equal(humanUnblock.status, 200);
  assert.equal((await readJson<IssueResponse>(humanUnblock)).issue.blockedReason, null);
});

test("issue labels are human-only, sorted, replaced, and recorded once", async () => {
  await seedIssue("todo");

  const applied = await request(app, "/api/issues/TAC-1/labels", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ labels: ["ui", "bug"] }),
  });
  assert.equal(applied.status, 200);
  assertJson(applied);
  assert.deepEqual((await readJson<IssueResponse>(applied)).issue.labels, [
    "bug",
    "ui",
  ]);

  const timeline = await request(app, "/api/issues/TAC-1", {
    headers: HUMAN_BEARER,
  });
  assert.equal(timeline.status, 200);
  assertJson(timeline);
  const shown = await readJson<IssueTimelineResponse>(timeline);
  assert.deepEqual(shown.issue.labels, ["bug", "ui"]);
  const labelEvents = shown.events.filter((event) => event.kind === "labels");
  assert.equal(labelEvents.length, 1);
  assert.equal(labelEvents[0]?.actorType, "human");
  assert.equal(labelEvents[0]?.fromStatus, null);
  assert.equal(labelEvents[0]?.toStatus, null);
  assert.deepEqual(JSON.parse(labelEvents[0]?.body ?? ""), {
    labels: ["bug", "ui"],
  });

  const replaced = await request(app, "/api/issues/TAC-1/labels", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ labels: ["backend"] }),
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual((await readJson<IssueResponse>(replaced)).issue.labels, [
    "backend",
  ]);
  const afterReplace = await readJson<IssueTimelineResponse>(
    await request(app, "/api/issues/TAC-1", { headers: HUMAN_BEARER }),
  );
  assert.deepEqual(afterReplace.issue.labels, ["backend"]);

  const cleared = await request(app, "/api/issues/TAC-1/labels", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ labels: [] }),
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await readJson<IssueResponse>(cleared)).issue.labels, []);
  const afterClear = await readJson<IssueTimelineResponse>(
    await request(app, "/api/issues/TAC-1", { headers: HUMAN_BEARER }),
  );
  assert.deepEqual(afterClear.issue.labels, []);

  const invalid = await request(app, "/api/issues/TAC-1/labels", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ labels: "nope" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    (await readJson<ErrorResponse>(invalid)).error.code,
    "validation",
  );

  const agentCreated = await createAgent(testDb.db, "agent-1");
  const forbidden = await request(app, "/api/issues/TAC-1/labels", {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentCreated.token}`,
      ...JSON_HEADERS,
    },
    body: JSON.stringify({ labels: ["ui"] }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (await readJson<ErrorResponse>(forbidden)).error.code,
    "forbidden_transition",
  );
});

test("issue relations are human-only, expose both directions, and ignore duplicates", async () => {
  await seedProject();
  await createIssue(testDb.db, {
    project: "TAC",
    title: "Blocked issue",
    status: "todo",
  });
  await createIssue(testDb.db, {
    project: "TAC",
    title: "Blocking issue",
    status: "todo",
  });

  const created = await request(app, "/api/issues/TAC-1/relations", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ blocking: "TAC-2" }),
  });
  assert.equal(created.status, 200);
  assertJson(created);
  const blockedIssue = (await readJson<IssueResponse>(created)).issue;
  assert.equal(blockedIssue.key, "TAC-1");
  assert.deepEqual(blockedIssue.relations.blockedBy, ["TAC-2"]);
  assert.deepEqual(blockedIssue.relations.blocks, []);

  const blocker = await readJson<IssueTimelineResponse>(
    await request(app, "/api/issues/TAC-2", { headers: HUMAN_BEARER }),
  );
  assert.deepEqual(blocker.issue.relations.blocks, ["TAC-1"]);
  assert.deepEqual(blocker.issue.relations.blockedBy, []);

  const blockedTimeline = await readJson<IssueTimelineResponse>(
    await request(app, "/api/issues/TAC-1", { headers: HUMAN_BEARER }),
  );
  assert.deepEqual(blockedTimeline.issue.relations.blockedBy, ["TAC-2"]);
  const relationEvents = blockedTimeline.events.filter(
    (event) => event.kind === "relation",
  );
  assert.equal(relationEvents.length, 1);
  assert.equal(relationEvents[0]?.actorType, "human");
  assert.equal(relationEvents[0]?.fromStatus, null);
  assert.equal(relationEvents[0]?.toStatus, null);
  assert.deepEqual(JSON.parse(relationEvents[0]?.body ?? ""), {
    blocking: "TAC-2",
    blocked: "TAC-1",
  });

  const duplicate = await request(app, "/api/issues/TAC-1/relations", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ blocking: "TAC-2" }),
  });
  assert.equal(duplicate.status, 200);
  const afterDuplicate = await readJson<IssueTimelineResponse>(
    await request(app, "/api/issues/TAC-1", { headers: HUMAN_BEARER }),
  );
  assert.deepEqual(afterDuplicate.issue.relations.blockedBy, ["TAC-2"]);
  assert.equal(
    afterDuplicate.events.filter((event) => event.kind === "relation").length,
    1,
  );

  const selfRelation = await request(app, "/api/issues/TAC-1/relations", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ blocking: "TAC-1" }),
  });
  assert.equal(selfRelation.status, 400);
  assert.equal(
    (await readJson<ErrorResponse>(selfRelation)).error.code,
    "validation",
  );

  const missing = await request(app, "/api/issues/TAC-1/relations", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ blocking: "ZZZ-9" }),
  });
  assert.equal(missing.status, 404);
  assert.equal((await readJson<ErrorResponse>(missing)).error.code, "not_found");

  const agentCreated = await createAgent(testDb.db, "agent-1");
  const forbidden = await request(app, "/api/issues/TAC-1/relations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentCreated.token}`,
      ...JSON_HEADERS,
    },
    body: JSON.stringify({ blocking: "TAC-2" }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (await readJson<ErrorResponse>(forbidden)).error.code,
    "forbidden_transition",
  );
});

test("the ready queue and claims skip a todo issue with an open blocker", async () => {
  await seedProject();
  await createIssue(testDb.db, {
    project: "TAC",
    title: "Blocked issue",
    status: "todo",
  });
  await createIssue(testDb.db, {
    project: "TAC",
    title: "Blocking issue",
    status: "todo",
  });

  const relation = await request(app, "/api/issues/TAC-1/relations", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: JSON.stringify({ blocking: "TAC-2" }),
  });
  assert.equal(relation.status, 200);

  const agentCreated = await createAgent(testDb.db, "agent-1");
  const agent = { authorization: `Bearer ${agentCreated.token}` };

  const blockedReady = await request(app, "/api/ready?project=TAC", {
    headers: agent,
  });
  assert.equal(blockedReady.status, 200);
  assertJson(blockedReady);
  const blockedQueue = await readJson<ReadyResponse>(blockedReady);
  assert.equal(blockedQueue.busy, null);
  assert.deepEqual(
    blockedQueue.ready.map((entry) => entry.key),
    ["TAC-2"],
  );

  const claimed = await request(app, "/api/claims/next?project=TAC", {
    method: "POST",
    headers: agent,
  });
  assert.equal(claimed.status, 201);
  assert.equal((await readJson<IssueResponse>(claimed)).issue.key, "TAC-2");

  const released = await request(app, "/api/issues/TAC-2/release", {
    method: "POST",
    headers: agent,
  });
  assert.equal(released.status, 200);
  assert.equal((await readJson<IssueResponse>(released)).issue.status, "todo");

  for (const to of ["in_progress", "in_review", "done"]) {
    const moved = await request(app, "/api/issues/TAC-2/transition", {
      method: "POST",
      headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
      body: JSON.stringify({ to }),
    });
    assert.equal(moved.status, 200);
    assert.equal((await readJson<IssueResponse>(moved)).issue.status, to);
  }

  const unblockedReady = await request(app, "/api/ready?project=TAC", {
    headers: agent,
  });
  assert.equal(unblockedReady.status, 200);
  assert.deepEqual(
    (await readJson<ReadyResponse>(unblockedReady)).ready.map(
      (entry) => entry.key,
    ),
    ["TAC-1"],
  );

  const nextClaim = await request(app, "/api/claims/next?project=TAC", {
    method: "POST",
    headers: agent,
  });
  assert.equal(nextClaim.status, 201);
  const unblockedClaim = (await readJson<IssueResponse>(nextClaim)).issue;
  assert.equal(unblockedClaim.key, "TAC-1");
  assert.equal(unblockedClaim.status, "in_progress");
});

test("responses never carry CORS headers", async () => {
  const get = await request(app, "/api/me", { headers: COOKIE_HEADER });
  assert.equal(get.headers.get("access-control-allow-origin"), null);

  const options = await request(app, "/api/me", { method: "OPTIONS" });
  assert.equal(options.headers.get("access-control-allow-origin"), null);
});

test("mutations require JSON content with a parseable body", async () => {
  const wrongType = await request(app, "/api/projects", {
    method: "POST",
    headers: { ...HUMAN_BEARER, "content-type": "text/plain" },
    body: JSON.stringify({ key: "BAD", name: "Bad" }),
  });
  assert.equal(wrongType.status, 400);
  assertJson(wrongType);
  assert.equal(
    (await readJson<ErrorResponse>(wrongType)).error.code,
    "validation",
  );

  const malformed = await request(app, "/api/projects", {
    method: "POST",
    headers: { ...HUMAN_BEARER, ...JSON_HEADERS },
    body: "{not json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(
    (await readJson<ErrorResponse>(malformed)).error.code,
    "validation",
  );
});

test("unknown API routes return JSON 404 instead of HTML", async () => {
  const response = await request(app, "/api/does-not-exist", {
    headers: HUMAN_BEARER,
  });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal((await readJson<ErrorResponse>(response)).error.code, "not_found");
});

test("SPA serving uses the fixture build, caches by kind, and rejects traversal", async () => {
  const dist = await mkdtemp(join(tmpdir(), "curved-http-dist-"));
  try {
    await mkdir(join(dist, "assets"));
    await writeFile(
      join(dist, "index.html"),
      "<!doctype html><html><body>curved spa shell</body></html>",
    );
    await writeFile(join(dist, "assets", "app-abc123.js"), "console.log('app');");

    const spa = createApp({
      db: testDb.db,
      uiToken: UI_TOKEN,
      webDistDir: dist,
      logger: () => {},
    });

    const index = await request(spa, "/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(index.headers.get("cache-control") ?? "", /no-cache/);
    assert.match(await index.text(), /curved spa shell/);

    const asset = await request(spa, "/assets/app-abc123.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.match(await asset.text(), /console\.log\('app'\)/);

    const clientRoute = await request(spa, "/projects/TAC");
    assert.equal(clientRoute.status, 200);
    assert.match(clientRoute.headers.get("content-type") ?? "", /text\/html/);
    assert.match(clientRoute.headers.get("cache-control") ?? "", /no-cache/);
    assert.match(await clientRoute.text(), /curved spa shell/);

    const traversal = await request(spa, "/assets/..%2F..%2Fpackage.json");
    assert.ok(
      traversal.status === 400 || traversal.status === 404,
      `expected traversal to be rejected, got ${traversal.status}`,
    );
    assert.doesNotMatch(await traversal.text(), /"name":\s*"curved"/);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("a missing web build returns 503 text explaining how to build", async () => {
  const missingDir = join(tmpdir(), `curved-http-missing-${process.pid}-${Date.now()}`);
  const spa = createApp({
    db: testDb.db,
    uiToken: UI_TOKEN,
    webDistDir: missingDir,
    logger: () => {},
  });

  const response = await request(spa, "/");
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  const body = await response.text();
  assert.match(body, /web\/dist/);
  assert.match(body, /build/i);
});
