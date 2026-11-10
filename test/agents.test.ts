import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { pgErrorCode, pgErrorConstraint } from "../src/db.ts";
import { ServiceError, type ErrorCode } from "../src/errors.ts";
import {
  authenticateAgent,
  createAgent,
  ensureAgentExists,
  hashAgentToken,
} from "../src/services/agents.ts";
import { commentOnIssue } from "../src/services/comments.ts";
import { listEvents, type IssueEvent } from "../src/services/events.ts";
import {
  createIssue,
  getIssue,
  moveIssue,
  type Issue,
} from "../src/services/issues.ts";
import { createProject } from "../src/services/projects.ts";
import {
  claimNext,
  listReady,
  releaseClaim,
  submitForReview,
} from "../src/services/queue.ts";
import type { Status } from "../src/shared/status.ts";
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

function rejectsWithServiceCode(code: ErrorCode): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(
      error instanceof ServiceError,
      `expected ServiceError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  };
}

async function seedProject(key = "TAC"): Promise<void> {
  await createProject(testDb.db, { key, name: key });
}

interface SeedIssueOptions {
  project?: string;
  title?: string;
  status?: Status;
  priority?: number;
}

async function seedIssue(options: SeedIssueOptions = {}): Promise<Issue> {
  return createIssue(testDb.db, {
    project: options.project ?? "TAC",
    title: options.title ?? "Queue issue",
    status: options.status ?? "todo",
    priority: options.priority ?? 3,
  });
}

async function seedAgent(name: string): Promise<void> {
  await createAgent(testDb.db, name);
}

function withKind(events: IssueEvent[], kind: IssueEvent["kind"]): IssueEvent[] {
  return events.filter((event) => event.kind === kind);
}

async function claimEventCount(): Promise<number> {
  const row = await testDb.db.one<{ count: number }>(
    `select count(*)::int as count from issue_events where kind = 'claim'`,
  );
  assert.ok(row, "claim count query returned no row");
  return row.count;
}

async function activeClaims(agent: string): Promise<string[]> {
  const rows = await testDb.db.query<{ key: string }>(
    `select key
     from issues
     where claimed_by = $1 and status in ('in_progress', 'in_review')
     order by key asc`,
    [agent],
  );
  return rows.map((row) => row.key);
}

function fulfilledValues<T>(
  results: PromiseSettledResult<T>[],
): T[] {
  return results
    .filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled")
    .map((result) => result.value);
}

function rejectedReasons(
  results: PromiseSettledResult<unknown>[],
): unknown[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
}

// --- Agent identity and tokens -------------------------------------------

test("createAgent mints a prefixed token, stores only its hash, and authenticates", async () => {
  const created = await createAgent(testDb.db, "  alpha  ");

  assert.match(created.token, /^crv_[A-Za-z0-9_-]{32}$/);
  assert.equal(created.agent.name, "alpha");

  const row = await testDb.db.one<{ token_hash: string }>(
    `select token_hash from agents where name = $1`,
    ["alpha"],
  );
  assert.ok(row, "created agent row is missing");
  assert.equal(row.token_hash, hashAgentToken(created.token));
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, created.token);

  const authenticated = await authenticateAgent(testDb.db, created.token);
  assert.equal(authenticated.id, created.agent.id);
  assert.equal(authenticated.name, "alpha");
  assert.equal(authenticated.createdAt, created.agent.createdAt);
});

test("createAgent rejects duplicate names and invalid names", async () => {
  await createAgent(testDb.db, "alpha");

  await assert.rejects(
    createAgent(testDb.db, "alpha"),
    rejectsWithServiceCode("duplicate"),
  );
  await assert.rejects(
    createAgent(testDb.db, "  alpha  "),
    rejectsWithServiceCode("duplicate"),
  );

  for (const name of ["", "   ", "\t\n", "x".repeat(101)]) {
    await assert.rejects(
      createAgent(testDb.db, name),
      rejectsWithServiceCode("validation"),
      JSON.stringify(name),
    );
  }

  const row = await testDb.db.one<{ count: number }>(
    "select count(*)::int as count from agents",
  );
  assert.ok(row, "agent count query returned no row");
  assert.equal(row.count, 1);
});

test("authenticateAgent rejects blank and unknown tokens and ensureAgentExists distinguishes names", async () => {
  await seedAgent("alpha");

  for (const token of ["", "   ", "\t\n"]) {
    await assert.rejects(
      authenticateAgent(testDb.db, token),
      rejectsWithServiceCode("not_authenticated"),
      JSON.stringify(token),
    );
  }
  await assert.rejects(
    authenticateAgent(testDb.db, `crv_${"a".repeat(32)}`),
    rejectsWithServiceCode("not_authenticated"),
  );

  await ensureAgentExists(testDb.db, "alpha");
  await assert.rejects(
    ensureAgentExists(testDb.db, "ghost"),
    rejectsWithServiceCode("not_found"),
  );
});

// --- Ready queue ----------------------------------------------------------

test("listReady returns only unblocked todo issues ordered by priority then number", async () => {
  await seedProject("TAC");

  const lowPriority = await seedIssue({ priority: 3 });
  const firstHigh = await seedIssue({ priority: 1 });
  const secondHigh = await seedIssue({ priority: 1 });
  const medium = await seedIssue({ priority: 2 });
  const blocked = await seedIssue({ priority: 1 });
  await seedIssue({ status: "backlog", priority: 1 });
  await seedIssue({ status: "in_progress", priority: 1 });

  await testDb.db.query(
    `update issues set blocked_reason = 'waiting on design' where id = $1`,
    [blocked.id],
  );

  const queue = await listReady(testDb.db);

  assert.deepEqual(
    queue.ready.map((issue) => issue.key),
    [firstHigh.key, secondHigh.key, medium.key, lowPriority.key],
  );
  for (const issue of queue.ready) {
    assert.equal(issue.status, "todo");
    assert.equal(issue.blockedReason, null);
  }
  assert.equal(queue.busy, null);
});

test("listReady filters by project and rejects an unknown project", async () => {
  await seedProject("TAC");
  await seedProject("OPS");
  const tactics = await seedIssue({ project: "TAC" });
  const operations = await seedIssue({ project: "OPS" });

  const filtered = await listReady(testDb.db, { project: "OPS" });
  assert.deepEqual(
    filtered.ready.map((issue) => issue.key),
    [operations.key],
  );

  const all = await listReady(testDb.db);
  assert.deepEqual(
    all.ready.map((issue) => issue.key),
    [operations.key, tactics.key],
  );

  await assert.rejects(
    listReady(testDb.db, { project: "ZZZ" }),
    rejectsWithServiceCode("not_found"),
  );
});

test("listReady reports an agent's active claim as busy and applies the fence across projects", async () => {
  await seedProject("TAC");
  await seedProject("OPS");
  await seedAgent("alpha");
  const tactics = await seedIssue({ project: "TAC" });
  const operations = await seedIssue({ project: "OPS" });

  const idle = await listReady(testDb.db, undefined, {
    actor: "agent",
    agent: "alpha",
  });
  assert.equal(idle.busy, null);

  const claimed = await claimNext(testDb.db, { project: "TAC" }, "alpha");
  assert.equal(claimed.key, tactics.key);

  const inProgress = await listReady(testDb.db, { project: "OPS" }, {
    actor: "agent",
    agent: "alpha",
  });
  assert.equal(inProgress.busy, tactics.key);
  assert.deepEqual(
    inProgress.ready.map((issue) => issue.key),
    [operations.key],
  );

  await submitForReview(testDb.db, {
    key: tactics.key,
    agent: "alpha",
    summary: "ready for review",
  });

  const inReview = await listReady(testDb.db, { project: "OPS" }, {
    actor: "agent",
    agent: "alpha",
  });
  assert.equal(inReview.busy, tactics.key);

  await moveIssue(testDb.db, {
    key: tactics.key,
    to: "in_progress",
    actor: "human",
  });

  await releaseClaim(testDb.db, { key: tactics.key, agent: "alpha" });

  const released = await listReady(testDb.db, { project: "OPS" }, {
    actor: "agent",
    agent: "alpha",
  });
  assert.equal(released.busy, null);
});

// --- Claiming -------------------------------------------------------------

test("claimNext claims the highest-priority ready issue and appends one claim event", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  await seedIssue({ priority: 3 });
  const target = await seedIssue({ priority: 1 });
  await seedIssue({ priority: 2 });

  const claimed = await claimNext(testDb.db, {}, "alpha");

  assert.equal(claimed.key, target.key);
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.claimedBy, "alpha");
  assert.equal(claimed.priority, 1);
  assert.deepEqual(claimed.allowedTransitions, ["todo", "in_review"]);

  const current = await getIssue(testDb.db, target.key);
  assert.equal(current.status, "in_progress");
  assert.equal(current.claimedBy, "alpha");

  const events = await listEvents(testDb.db, target.id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "claim"],
  );
  const claims = withKind(events, "claim");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.issueId, target.id);
  assert.equal(claims[0]?.actorType, "agent");
  assert.equal(claims[0]?.fromStatus, "todo");
  assert.equal(claims[0]?.toStatus, "in_progress");
  assert.equal(claims[0]?.body, null);
  assert.equal(await claimEventCount(), 1);
});

test("claimNext rejects an empty queue with no_ready_issue", async () => {
  await seedAgent("alpha");

  await assert.rejects(
    claimNext(testDb.db, {}, "alpha"),
    rejectsWithServiceCode("no_ready_issue"),
  );

  await seedProject("TAC");
  await seedIssue({ status: "backlog" });
  await seedIssue({ status: "in_progress" });
  await seedIssue({ status: "done" });

  await assert.rejects(
    claimNext(testDb.db, { project: "TAC" }, "alpha"),
    rejectsWithServiceCode("no_ready_issue"),
  );
  assert.equal(await claimEventCount(), 0);
});

test("claimNext rejects an agent that already holds an in_progress or in_review issue with agent_busy", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  const held = await seedIssue({ priority: 1 });
  await seedIssue({ priority: 2 });
  await seedIssue({ priority: 3 });

  await claimNext(testDb.db, {}, "alpha");

  await assert.rejects(
    claimNext(testDb.db, {}, "alpha"),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
      assert.equal(error.code, "agent_busy");
      assert.match(error.message, new RegExp(held.key));
      return true;
    },
  );

  await submitForReview(testDb.db, {
    key: held.key,
    agent: "alpha",
    summary: "handing over",
  });

  await assert.rejects(
    claimNext(testDb.db, {}, "alpha"),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
      assert.equal(error.code, "agent_busy");
      assert.match(error.message, new RegExp(held.key));
      return true;
    },
  );

  assert.deepEqual(await activeClaims("alpha"), [held.key]);
  assert.equal(await claimEventCount(), 1);
});

test("two agents racing one ready issue produce exactly one claim", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  await seedAgent("beta");
  const contest = await seedIssue({ title: "Contested" });

  const results = await Promise.allSettled(
    ["alpha", "beta"].map(async (agent) => ({
      agent,
      issue: await claimNext(testDb.db, {}, agent),
    })),
  );

  const winners = fulfilledValues(results);
  const losers = rejectedReasons(results);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);

  const winner = winners[0];
  assert.ok(winner, "expected one fulfilled claim");
  const loserReason = losers[0];
  assert.ok(loserReason instanceof ServiceError, `expected ServiceError, got ${String(loserReason)}`);
  assert.equal(loserReason.code, "no_ready_issue");

  assert.equal(winner.issue.key, contest.key);
  assert.equal(winner.issue.status, "in_progress");
  assert.equal(winner.issue.claimedBy, winner.agent);

  const current = await getIssue(testDb.db, contest.key);
  assert.equal(current.claimedBy, winner.agent);
  assert.equal(current.status, "in_progress");

  assert.equal(await claimEventCount(), 1);
  const events = await listEvents(testDb.db, contest.id);
  const claims = withKind(events, "claim");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.fromStatus, "todo");
  assert.equal(claims[0]?.toStatus, "in_progress");
});

test("concurrent claims by the same agent produce one success and one agent_busy", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  await seedIssue({ priority: 1 });
  await seedIssue({ priority: 2 });

  const results = await Promise.allSettled([
    claimNext(testDb.db, {}, "alpha"),
    claimNext(testDb.db, {}, "alpha"),
  ]);

  const claims = fulfilledValues(results);
  const failures = rejectedReasons(results);
  assert.equal(claims.length, 1);
  assert.equal(failures.length, 1);

  const claimed = claims[0];
  assert.ok(claimed, "expected one fulfilled claim");
  const failure = failures[0];
  assert.ok(failure instanceof ServiceError, `expected ServiceError, got ${String(failure)}`);
  assert.equal(failure.code, "agent_busy");
  assert.match(failure.message, new RegExp(claimed.key));

  assert.deepEqual(await activeClaims("alpha"), [claimed.key]);
  assert.equal(await claimEventCount(), 1);
});

test("raw SQL cannot give one agent a second active claim", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  const first = await seedIssue({ priority: 1 });
  await claimNext(testDb.db, {}, "alpha");
  const second = await seedIssue({ priority: 2 });

  await assert.rejects(
    testDb.db.query(
      `update issues set status = 'in_progress', claimed_by = $1 where key = $2`,
      ["alpha", second.key],
    ),
    (error: unknown) => {
      assert.equal(pgErrorCode(error), "23505");
      assert.equal(
        pgErrorConstraint(error),
        "issues_one_active_claim_per_agent",
      );
      return true;
    },
  );

  const unchanged = await getIssue(testDb.db, second.key);
  assert.equal(unchanged.status, "todo");
  assert.equal(unchanged.claimedBy, null);
  assert.deepEqual(await activeClaims("alpha"), [first.key]);
});

test("moveIssue maps a second active claim to agent_busy and leaves the target todo", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  const held = await seedIssue({ priority: 1 });
  await claimNext(testDb.db, {}, "alpha");
  const target = await seedIssue({ priority: 2 });

  await assert.rejects(
    moveIssue(testDb.db, {
      key: target.key,
      to: "in_progress",
      actor: "agent",
      agent: "alpha",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError, `expected ServiceError, got ${String(error)}`);
      assert.equal(error.code, "agent_busy");
      assert.match(error.message, new RegExp(held.key));
      return true;
    },
  );

  const current = await getIssue(testDb.db, target.key);
  assert.equal(current.status, "todo");
  assert.equal(current.claimedBy, null);
  assert.deepEqual(
    (await listEvents(testDb.db, target.id)).map((event) => event.kind),
    ["created"],
  );
  assert.deepEqual(await activeClaims("alpha"), [held.key]);
});

// --- Review and release ---------------------------------------------------

test("submitForReview records one review_submitted event and keeps the claim", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  const issue = await seedIssue({ priority: 1 });
  await claimNext(testDb.db, {}, "alpha");

  const reviewed = await submitForReview(testDb.db, {
    key: issue.key,
    agent: "alpha",
    summary: "  ready for review  ",
  });

  assert.equal(reviewed.status, "in_review");
  assert.equal(reviewed.claimedBy, "alpha");

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "in_review");
  assert.equal(current.claimedBy, "alpha");

  const events = await listEvents(testDb.db, issue.id);
  const reviews = withKind(events, "review_submitted");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.issueId, issue.id);
  assert.equal(reviews[0]?.actorType, "agent");
  assert.equal(reviews[0]?.fromStatus, "in_progress");
  assert.equal(reviews[0]?.toStatus, "in_review");
  assert.equal(reviews[0]?.body, "ready for review");
});

test("submitForReview rejects non-owners, blank summaries, released issues, double reviews, and unknown keys", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  await seedAgent("beta");
  const issue = await seedIssue({ priority: 1 });
  await claimNext(testDb.db, {}, "alpha");

  await assert.rejects(
    submitForReview(testDb.db, {
      key: issue.key,
      agent: "beta",
      summary: "not mine",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );
  assert.deepEqual(withKind(await listEvents(testDb.db, issue.id), "review_submitted"), []);

  for (const summary of ["", "   ", "\t\n "]) {
    await assert.rejects(
      submitForReview(testDb.db, {
        key: issue.key,
        agent: "alpha",
        summary,
      }),
      rejectsWithServiceCode("validation"),
      JSON.stringify(summary),
    );
  }
  assert.deepEqual(withKind(await listEvents(testDb.db, issue.id), "review_submitted"), []);

  await releaseClaim(testDb.db, { key: issue.key, agent: "alpha" });

  // A released issue is unclaimed, so the ownership gate fires before the
  // status gate and rejects the old claimant.
  await assert.rejects(
    submitForReview(testDb.db, {
      key: issue.key,
      agent: "alpha",
      summary: "too late",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );

  await assert.rejects(
    submitForReview(testDb.db, {
      key: "TAC-99",
      agent: "alpha",
      summary: "missing",
    }),
    rejectsWithServiceCode("not_found"),
  );
  assert.deepEqual(withKind(await listEvents(testDb.db, issue.id), "review_submitted"), []);

  // Re-claim, submit once, then a second submit hits the status gate.
  await claimNext(testDb.db, {}, "alpha");
  await submitForReview(testDb.db, {
    key: issue.key,
    agent: "alpha",
    summary: "first review",
  });
  await assert.rejects(
    submitForReview(testDb.db, {
      key: issue.key,
      agent: "alpha",
      summary: "second review",
    }),
    rejectsWithServiceCode("illegal_transition"),
  );
  assert.equal(
    withKind(await listEvents(testDb.db, issue.id), "review_submitted").length,
    1,
  );
});

test("releaseClaim returns the issue to todo and records one release event", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  await seedAgent("beta");
  const issue = await seedIssue({ priority: 1 });
  await claimNext(testDb.db, {}, "alpha");

  await assert.rejects(
    releaseClaim(testDb.db, { key: issue.key, agent: "beta" }),
    rejectsWithServiceCode("forbidden_transition"),
  );
  const stillHeld = await getIssue(testDb.db, issue.key);
  assert.equal(stillHeld.status, "in_progress");
  assert.equal(stillHeld.claimedBy, "alpha");
  assert.deepEqual(withKind(await listEvents(testDb.db, issue.id), "release"), []);

  const released = await releaseClaim(testDb.db, {
    key: issue.key,
    agent: "alpha",
  });

  assert.equal(released.status, "todo");
  assert.equal(released.claimedBy, null);

  const events = await listEvents(testDb.db, issue.id);
  const releases = withKind(events, "release");
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.issueId, issue.id);
  assert.equal(releases[0]?.actorType, "agent");
  assert.equal(releases[0]?.fromStatus, "in_progress");
  assert.equal(releases[0]?.toStatus, "todo");
  assert.equal(releases[0]?.body, null);

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "todo");
  assert.equal(current.claimedBy, null);
});

test("releaseClaim rejects an in_review issue with illegal_transition", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  const issue = await seedIssue({ project: "TAC", priority: 1 });
  await claimNext(testDb.db, { project: "TAC" }, "alpha");
  await submitForReview(testDb.db, {
    key: issue.key,
    agent: "alpha",
    summary: "reviewing",
  });

  await assert.rejects(
    releaseClaim(testDb.db, { key: issue.key, agent: "alpha" }),
    rejectsWithServiceCode("illegal_transition"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "in_review");
  assert.equal(current.claimedBy, "alpha");
});

// --- Comment ownership ----------------------------------------------------

test("commentOnIssue enforces agent ownership and requires a known agent identity", async () => {
  await seedProject("TAC");
  await seedAgent("alpha");
  await seedAgent("beta");
  const claimed = await seedIssue({ priority: 1 });
  const unclaimed = await seedIssue({ priority: 2 });
  await claimNext(testDb.db, {}, "alpha");

  await assert.rejects(
    commentOnIssue(testDb.db, {
      key: claimed.key,
      body: "not mine",
      actor: "agent",
      agent: "beta",
    }),
    rejectsWithServiceCode("forbidden_transition"),
  );
  assert.deepEqual(withKind(await listEvents(testDb.db, claimed.id), "comment"), []);

  const owner = await commentOnIssue(testDb.db, {
    key: claimed.key,
    body: "  owner here  ",
    actor: "agent",
    agent: "alpha",
  });
  assert.equal(owner.kind, "comment");
  assert.equal(owner.actorType, "agent");
  assert.equal(owner.body, "owner here");

  const human = await commentOnIssue(testDb.db, {
    key: claimed.key,
    body: "human note",
    actor: "human",
  });
  assert.equal(human.actorType, "human");

  const onUnclaimed = await commentOnIssue(testDb.db, {
    key: unclaimed.key,
    body: "free issue comment",
    actor: "agent",
    agent: "alpha",
  });
  assert.equal(onUnclaimed.actorType, "agent");

  await assert.rejects(
    commentOnIssue(testDb.db, {
      key: claimed.key,
      body: "no identity",
      actor: "agent",
    }),
    rejectsWithServiceCode("validation"),
  );
  await assert.rejects(
    commentOnIssue(testDb.db, {
      key: claimed.key,
      body: "ghost identity",
      actor: "agent",
      agent: "ghost",
    }),
    rejectsWithServiceCode("not_found"),
  );

  assert.equal(withKind(await listEvents(testDb.db, claimed.id), "comment").length, 2);
  assert.equal(withKind(await listEvents(testDb.db, unclaimed.id), "comment").length, 1);
});

// --- Freeing the claim fence ----------------------------------------------

test("releaseClaim frees the agent to claim an issue in another project", async () => {
  await seedProject("TAC");
  await seedProject("OPS");
  await seedAgent("alpha");
  const tactics = await seedIssue({ project: "TAC", priority: 1 });
  const operations = await seedIssue({ project: "OPS", priority: 1 });

  const first = await claimNext(testDb.db, { project: "TAC" }, "alpha");
  assert.equal(first.key, tactics.key);
  await releaseClaim(testDb.db, { key: tactics.key, agent: "alpha" });

  const second = await claimNext(testDb.db, { project: "OPS" }, "alpha");
  assert.equal(second.key, operations.key);
  assert.equal(second.claimedBy, "alpha");
  assert.deepEqual(await activeClaims("alpha"), [operations.key]);
});

test("a human moving an in_review issue to done frees the agent for the next claim", async () => {
  await seedProject("TAC");
  await seedProject("OPS");
  await seedAgent("alpha");
  const tactics = await seedIssue({ project: "TAC", priority: 1 });
  const operations = await seedIssue({ project: "OPS", priority: 1 });

  await claimNext(testDb.db, { project: "TAC" }, "alpha");
  await submitForReview(testDb.db, {
    key: tactics.key,
    agent: "alpha",
    summary: "finished",
  });
  const done = await moveIssue(testDb.db, {
    key: tactics.key,
    to: "done",
    actor: "human",
  });
  assert.equal(done.status, "done");

  const next = await claimNext(testDb.db, { project: "OPS" }, "alpha");
  assert.equal(next.key, operations.key);
  assert.equal(next.claimedBy, "alpha");
  assert.deepEqual(await activeClaims("alpha"), [operations.key]);
});

// --- Identity write fences ------------------------------------------------

test("moveIssue requires a registered agent identity", async () => {
  await seedProject("TAC");
  const issue = await seedIssue({ priority: 1 });

  await assert.rejects(
    moveIssue(testDb.db, {
      key: issue.key,
      to: "in_progress",
      actor: "agent",
      agent: "ghost",
    }),
    rejectsWithServiceCode("not_found"),
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.status, "todo");
  assert.equal(current.claimedBy, null);
});

test("raw SQL cannot set issues.claimed_by to an unregistered agent", async () => {
  await seedProject("TAC");
  const issue = await seedIssue({ priority: 1 });

  await assert.rejects(
    testDb.db.query(
      `update issues set claimed_by = $1 where key = $2`,
      ["ghost", issue.key],
    ),
    (error: unknown) => pgErrorCode(error) === "23503",
  );

  const current = await getIssue(testDb.db, issue.key);
  assert.equal(current.claimedBy, null);
});
