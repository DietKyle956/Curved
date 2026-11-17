import type { Db, Database } from "../db.ts";
import { bindPorts } from "../adapters/postgres/ports.ts";
import { hydrateIssue, toIssue } from "../application/issue-read-model.ts";
import { ActiveClaimConflict } from "../application/ports.ts";
import type { TransactionPorts } from "../application/ports.ts";
import { resolveContext } from "../domain/actors.ts";
import type { IssueContext, ResolvedContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";
import { validateReviewSummary } from "../domain/validation.ts";
import { ensureAgentExists } from "./agents.ts";

export interface ReadyQueue {
  ready: Issue[];
  /** The agent's active issue key, or null when no agent is reading. */
  busy: string | null;
}

/**
 * Resolves the optional project filter: absent means every project, present
 * must name an existing project.
 */
async function resolveProjectFilter(
  ports: TransactionPorts,
  raw: string | undefined,
): Promise<string | null> {
  if (raw === undefined) {
    return null;
  }
  const existing = await ports.projects.findByKey(raw);
  if (existing === null) {
    throw new ServiceError("not_found", `project "${raw}" not found`);
  }
  return raw;
}

/** Reads the agent's one active claim, if it holds one. */
async function activeClaimKey(
  ports: TransactionPorts,
  agent: string,
): Promise<string | null> {
  return ports.issues.findActiveClaimKey(agent);
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
  const ports = bindPorts(db);
  const resolved: ResolvedContext = resolveContext(context);
  const project = await resolveProjectFilter(ports, options?.project);

  const rows = await ports.issues.listReady({ project });
  const meta = await ports.meta.loadForIds(rows.map((row) => row.id));

  let busy: string | null = null;
  if (resolved.actor === "agent" && resolved.agent !== null) {
    busy = await activeClaimKey(ports, resolved.agent);
  }

  return {
    ready: rows.map((row) => toIssue(row, resolved, meta.get(row.id))),
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
  const project = await resolveProjectFilter(bindPorts(db), options.project);

  try {
    return await db.tx(async (tx) => {
      const ports = bindPorts(tx);
      await tx.query(`select pg_advisory_xact_lock(727275, hashtext($1))`, [
        agentName,
      ]);

      const active = await activeClaimKey(ports, agentName);
      if (active !== null) {
        throw new ServiceError(
          "agent_busy",
          `agent "${agentName}" already holds issue "${active}"`,
        );
      }

      const candidate = await tx.one<{ id: number }>(
        `select i.id
         from issues i
         join projects p on p.id = i.project_id
         where i.status = 'todo'
           and i.blocked_reason is null
           and not exists (
             select 1
             from issue_relations r
             join issues blocker on blocker.id = r.blocking_issue_id
             where r.blocked_issue_id = i.id and blocker.status <> 'done'
           )
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

      await ports.issues.updateStatus({
        id: candidate.id,
        status: "in_progress",
        claimedBy: agentName,
      });
      await ports.events.append({
        issueId: candidate.id,
        kind: "claim",
        actorType: "agent",
        fromStatus: "todo",
        toStatus: "in_progress",
        body: null,
      });

      return hydrateIssue(ports, candidate.id, {
        actor: "agent",
        agent: agentName,
      });
    });
  } catch (error) {
    if (!(error instanceof ActiveClaimConflict)) {
      throw error;
    }
    const active = await activeClaimKey(bindPorts(db), agentName);
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
  const summary = validateReviewSummary(input.summary);
  const key = parseIssueKey(input.key).key;

  return db.tx(async (tx) => {
    const ports = bindPorts(tx);
    const locked = await ports.issues.lockByKey(key);
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.claimedBy !== agent) {
      throw new ServiceError(
        "forbidden_transition",
        `agent "${agent}" may not review issue "${key}" claimed by "${locked.claimedBy}"`,
      );
    }
    if (locked.status !== "in_progress") {
      throw new ServiceError(
        "illegal_transition",
        `issue "${key}" cannot be submitted for review from "${locked.status}"`,
      );
    }

    await ports.issues.updateStatus({
      id: locked.id,
      status: "in_review",
      claimedBy: agent,
    });
    await ports.events.append({
      issueId: locked.id,
      kind: "review_submitted",
      actorType: "agent",
      fromStatus: "in_progress",
      toStatus: "in_review",
      body: summary,
    });

    return hydrateIssue(ports, locked.id, { actor: "agent", agent });
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
    const ports = bindPorts(tx);
    const locked = await ports.issues.lockByKey(key);
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.claimedBy !== agent) {
      throw new ServiceError(
        "forbidden_transition",
        `agent "${agent}" may not release issue "${key}" claimed by "${locked.claimedBy}"`,
      );
    }
    if (locked.status !== "in_progress") {
      throw new ServiceError(
        "illegal_transition",
        `issue "${key}" cannot be released from "${locked.status}"`,
      );
    }

    await ports.issues.updateStatus({
      id: locked.id,
      status: "todo",
      claimedBy: null,
    });
    await ports.events.append({
      issueId: locked.id,
      kind: "release",
      actorType: "agent",
      fromStatus: "in_progress",
      toStatus: "todo",
      body: null,
    });

    return hydrateIssue(ports, locked.id, { actor: "agent", agent });
  });
}
