import type { QueryResultRow } from "pg";
import type { Db, Database } from "../db.ts";
import { pgErrorConstraint } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { appendEvent } from "./events.ts";
import { ensureAgentExists } from "./agents.ts";
import {
  hydrateIssue,
  parseIssueKey,
  resolveContext,
  ISSUE_COLUMNS,
  toIssue,
} from "./issues.ts";
import type {
  Issue,
  IssueContext,
  IssueRow,
  ResolvedContext,
} from "./issues.ts";

export interface ReadyQueue {
  ready: Issue[];
  /** The agent's active issue key, or null when no agent is reading. */
  busy: string | null;
}

interface KeyRow extends QueryResultRow {
  key: string;
}

interface IdRow extends QueryResultRow {
  id: number;
}

interface LockedIssueRow extends QueryResultRow {
  id: number;
  status: Issue["status"];
  claimed_by: string | null;
}

/**
 * Resolves the optional project filter: absent means every project, present
 * must name an existing project.
 */
async function resolveProjectFilter(
  db: Db,
  raw: string | undefined,
): Promise<string | null> {
  if (raw === undefined) {
    return null;
  }
  const existing = await db.one<IdRow>(`select id from projects where key = $1`, [
    raw,
  ]);
  if (existing === null) {
    throw new ServiceError("not_found", `project "${raw}" not found`);
  }
  return raw;
}

/** Reads the agent's one active claim, if it holds one. */
async function activeClaimKey(
  db: Db,
  agent: string,
): Promise<string | null> {
  const row = await db.one<KeyRow>(
    `select key from issues
     where claimed_by = $1 and status in ('in_progress', 'in_review')
     order by key asc
     limit 1`,
    [agent],
  );
  return row === null ? null : row.key;
}

/**
 * The ready backlog together with the reading agent's own active claim, so a
 * worker can tell it is already busy before it tries to claim again.
 */
export async function listReady(
  db: Db,
  options?: { project?: string },
  context?: IssueContext,
): Promise<ReadyQueue> {
  const resolved: ResolvedContext = resolveContext(context);
  const project = await resolveProjectFilter(db, options?.project);

  const rows = await db.query<IssueRow>(
    `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where i.status = 'todo'
       and i.blocked_reason is null
       and ($1::text is null or p.key = $1)
     order by i.priority asc, i.number asc, i.key asc`,
    [project],
  );

  let busy: string | null = null;
  if (resolved.actor === "agent" && resolved.agent !== null) {
    busy = await activeClaimKey(db, resolved.agent);
  }

  return {
    ready: rows.map((row) => toIssue(row, resolved)),
    busy,
  };
}

/**
 * Claims the highest-priority ready issue for an agent. Claims by the same
 * agent serialize on an advisory lock, and different agents compete through
 * `skip locked` so they never pile up behind one row.
 */
export async function claimNext(
  db: Database,
  options: { project?: string },
  agent: string,
): Promise<Issue> {
  const agentName = agent.trim();
  await ensureAgentExists(db, agentName);
  const project = await resolveProjectFilter(db, options.project);

  try {
    return await db.tx(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(727275, hashtext($1))`, [
        agentName,
      ]);

      const active = await activeClaimKey(tx, agentName);
      if (active !== null) {
        throw new ServiceError(
          "agent_busy",
          `agent "${agentName}" already holds issue "${active}"`,
        );
      }

      const candidate = await tx.one<IdRow>(
        `select i.id
         from issues i
         join projects p on p.id = i.project_id
         where i.status = 'todo'
           and i.blocked_reason is null
           and ($1::text is null or p.key = $1)
         order by i.priority asc, i.number asc, i.key asc
         limit 1
         for update of i skip locked`,
        [project],
      );
      if (candidate === null) {
        throw new ServiceError(
          "no_ready_issue",
          `no ready issue is available for agent "${agentName}"`,
        );
      }

      await tx.query(
        `update issues
         set status = 'in_progress', claimed_by = $2, updated_at = now()
         where id = $1`,
        [candidate.id, agentName],
      );
      await appendEvent(tx, {
        issueId: candidate.id,
        kind: "claim",
        actorType: "agent",
        fromStatus: "todo",
        toStatus: "in_progress",
        body: null,
      });

      return hydrateIssue(tx, candidate.id, { actor: "agent", agent: agentName });
    });
  } catch (error) {
    if (pgErrorConstraint(error) !== "issues_one_active_claim_per_agent") {
      throw error;
    }
    const active = await activeClaimKey(db, agentName);
    throw new ServiceError(
      "agent_busy",
      active === null
        ? `agent "${agentName}" already holds an active issue`
        : `agent "${agentName}" already holds issue "${active}"`,
    );
  }
}

/**
 * Submits an agent's claimed issue for review. Ownership is checked here
 * explicitly because this is not a generic status move.
 */
export async function submitForReview(
  db: Database,
  input: { key: string; agent: string; summary: string },
): Promise<Issue> {
  const agent = input.agent.trim();
  await ensureAgentExists(db, agent);
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new ServiceError("validation", "review summary must not be empty");
  }
  const key = parseIssueKey(input.key).key;

  return db.tx(async (tx) => {
    const locked = await tx.one<LockedIssueRow>(
      `select id, status, claimed_by from issues where key = $1 for update`,
      [key],
    );
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.claimed_by !== agent) {
      throw new ServiceError(
        "forbidden_transition",
        `agent "${agent}" may not review issue "${key}" claimed by "${locked.claimed_by}"`,
      );
    }
    if (locked.status !== "in_progress") {
      throw new ServiceError(
        "illegal_transition",
        `issue "${key}" cannot be submitted for review from "${locked.status}"`,
      );
    }

    await tx.query(
      `update issues set status = 'in_review', updated_at = now() where id = $1`,
      [locked.id],
    );
    await appendEvent(tx, {
      issueId: locked.id,
      kind: "review_submitted",
      actorType: "agent",
      fromStatus: "in_progress",
      toStatus: "in_review",
      body: summary,
    });

    return hydrateIssue(tx, locked.id, { actor: "agent", agent });
  });
}

/**
 * Returns an agent's claimed issue to the ready backlog. Ownership is checked
 * here explicitly because this is not a generic status move.
 */
export async function releaseClaim(
  db: Database,
  input: { key: string; agent: string },
): Promise<Issue> {
  const agent = input.agent.trim();
  await ensureAgentExists(db, agent);
  const key = parseIssueKey(input.key).key;

  return db.tx(async (tx) => {
    const locked = await tx.one<LockedIssueRow>(
      `select id, status, claimed_by from issues where key = $1 for update`,
      [key],
    );
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.claimed_by !== agent) {
      throw new ServiceError(
        "forbidden_transition",
        `agent "${agent}" may not release issue "${key}" claimed by "${locked.claimed_by}"`,
      );
    }
    if (locked.status !== "in_progress") {
      throw new ServiceError(
        "illegal_transition",
        `issue "${key}" cannot be released from "${locked.status}"`,
      );
    }

    await tx.query(
      `update issues
       set status = 'todo', claimed_by = null, updated_at = now()
       where id = $1`,
      [locked.id],
    );
    await appendEvent(tx, {
      issueId: locked.id,
      kind: "release",
      actorType: "agent",
      fromStatus: "in_progress",
      toStatus: "todo",
      body: null,
    });

    return hydrateIssue(tx, locked.id, { actor: "agent", agent });
  });
}
