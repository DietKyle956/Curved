import { resolveContext } from "../domain/actors.ts";
import type { IssueContext, ResolvedContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";
import { validateReviewSummary } from "../domain/validation.ts";
import { ensureAgentExists } from "./agents.ts";
import { hydrateIssue, toIssue } from "./issue-read-model.ts";
import { ActiveClaimConflict } from "./ports.ts";
import type { Ports, TransactionPorts } from "./ports.ts";

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
  ports: TransactionPorts,
  options?: { project?: string },
  context?: IssueContext,
): Promise<ReadyQueue> {
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
  ports: Ports,
  options: { project?: string },
  agent: string,
): Promise<Issue> {
  const agentName = agent.trim();
  await ensureAgentExists(ports, agentName);
  const project = await resolveProjectFilter(ports, options.project);

  try {
    return await ports.transaction(async (tx) => {
      await tx.agents.acquireClaimLock(agentName);

      const active = await activeClaimKey(tx, agentName);
      if (active !== null) {
        throw new ServiceError(
          "agent_busy",
          `agent "${agentName}" already holds issue "${active}"`,
        );
      }

      const candidate = await tx.issues.lockClaimCandidate({ project });
      if (candidate === null) {
        throw new ServiceError(
          "no_ready_issue",
          `no ready issue is available for agent "${agentName}"`,
        );
      }

      await tx.issues.updateStatus({
        id: candidate.id,
        status: "in_progress",
        claimedBy: agentName,
      });
      await tx.events.append({
        issueId: candidate.id,
        kind: "claim",
        actorType: "agent",
        fromStatus: "todo",
        toStatus: "in_progress",
        body: null,
      });

      return hydrateIssue(tx, candidate.id, {
        actor: "agent",
        agent: agentName,
      });
    });
  } catch (error) {
    if (!(error instanceof ActiveClaimConflict)) {
      throw error;
    }
    const active = await activeClaimKey(ports, agentName);
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
  ports: Ports,
  input: { key: string; agent: string; summary: string },
): Promise<Issue> {
  const agent = input.agent.trim();
  await ensureAgentExists(ports, agent);
  const summary = validateReviewSummary(input.summary);
  const key = parseIssueKey(input.key).key;

  return ports.transaction(async (tx) => {
    const locked = await tx.issues.lockByKey(key);
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

    await tx.issues.updateStatus({
      id: locked.id,
      status: "in_review",
      claimedBy: agent,
    });
    await tx.events.append({
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
  ports: Ports,
  input: { key: string; agent: string },
): Promise<Issue> {
  const agent = input.agent.trim();
  await ensureAgentExists(ports, agent);
  const key = parseIssueKey(input.key).key;

  return ports.transaction(async (tx) => {
    const locked = await tx.issues.lockByKey(key);
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

    await tx.issues.updateStatus({
      id: locked.id,
      status: "todo",
      claimedBy: null,
    });
    await tx.events.append({
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
