import {
  resolveContext,
  validateActor,
} from "../domain/actors.ts";
import type { IssueContext } from "../domain/actors.ts";
import { nextClaimedBy } from "../domain/claim.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import { mayMove } from "../domain/move-policy.ts";
import { DEFAULT_PRIORITY, DEFAULT_STATUS } from "../domain/status.ts";
import { isLegalTransition } from "../domain/transition.ts";
import { emptyMeta } from "../domain/types.ts";
import type { Issue, IssueEvent } from "../domain/types.ts";
import {
  validatePriority,
  validateProjectKey,
  validateStatus,
  validateTitle,
} from "../domain/validation.ts";
import { hydrateIssue, toIssue } from "./issue-read-model.ts";
import { ActiveClaimConflict } from "./ports.ts";
import type { Ports, TransactionPorts } from "./ports.ts";

export interface CreateIssueInput {
  project: string;
  title: string;
  description?: string;
  priority?: number;
  status?: string;
  parent?: string;
  actor?: string;
}

export async function createIssue(
  ports: Ports,
  input: CreateIssueInput,
): Promise<Issue> {
  const project = validateProjectKey(input.project);
  const title = validateTitle(input.title);
  const description = input.description ?? "";
  const priority = validatePriority(input.priority ?? DEFAULT_PRIORITY);
  const status = validateStatus(input.status ?? DEFAULT_STATUS);
  const actor = validateActor(input.actor ?? "human");

  return ports.transaction(async (tx) => {
    let parentId: number | null = null;
    if (input.parent !== undefined) {
      const parentKey = parseIssueKey(input.parent).key;
      const parent = await tx.issues.findByKey(parentKey);
      if (parent === null) {
        throw new ServiceError(
          "not_found",
          `parent issue "${parentKey}" not found`,
        );
      }
      parentId = parent.id;
    }

    const created = await tx.issues.create({
      projectKey: project,
      title,
      description,
      status,
      priority,
      parentId,
    });
    if (created === null) {
      throw new ServiceError("not_found", `project "${project}" not found`);
    }

    const issue = toIssue(created, { actor, agent: null });
    await tx.events.append({
      issueId: issue.id,
      kind: "created",
      actorType: actor,
      fromStatus: null,
      toStatus: issue.status,
      body: null,
    });
    return issue;
  });
}

export async function listIssues(
  ports: TransactionPorts,
  filter?: { project?: string; status?: string },
  context?: IssueContext,
): Promise<Issue[]> {
  const resolved = resolveContext(context);
  let project: string | null = null;
  if (filter?.project !== undefined) {
    project = validateProjectKey(filter.project);
  }
  const status =
    filter?.status === undefined ? null : validateStatus(filter.status);

  const rows = await ports.issues.list({ project, status });
  if (rows.length > 0) {
    const meta = await ports.meta.loadForIds(rows.map((row) => row.id));
    return rows.map((row) =>
      toIssue(row, resolved, meta.get(row.id) ?? emptyMeta()),
    );
  }
  // An empty list may mean an unknown project rather than an empty one.
  if (project !== null) {
    const existing = await ports.projects.findByKey(project);
    if (existing === null) {
      throw new ServiceError("not_found", `project "${project}" not found`);
    }
  }
  return [];
}

export interface UpdateIssueInput {
  key: string;
  title?: string;
  description?: string;
  priority?: number;
  actor?: string;
  agent?: string;
}

/**
 * Edits an issue's mutable fields. Field edits are not status history, so no
 * event is appended. Only humans may edit.
 */
export async function updateIssue(
  ports: Ports,
  input: UpdateIssueInput,
): Promise<Issue> {
  const { actor } = resolveContext({ actor: input.actor, agent: input.agent });
  if (actor !== "human") {
    throw new ServiceError(
      "forbidden_transition",
      `actor "${actor}" may not edit issue "${input.key}"`,
    );
  }
  if (
    input.title === undefined &&
    input.description === undefined &&
    input.priority === undefined
  ) {
    throw new ServiceError(
      "validation",
      "at least one of title, description, or priority is required",
    );
  }

  const title = input.title === undefined ? null : validateTitle(input.title);
  const description = input.description ?? null;
  const priority =
    input.priority === undefined ? null : validatePriority(input.priority);
  const key = parseIssueKey(input.key).key;

  return ports.transaction(async (tx) => {
    const updated = await tx.issues.updateFields({
      key,
      title,
      description,
      priority,
    });
    if (updated === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    return hydrateIssue(tx, updated.id, { actor: "human", agent: null });
  });
}

export async function getIssue(
  ports: TransactionPorts,
  key: string,
  context?: IssueContext,
): Promise<Issue> {
  const resolved = resolveContext(context);
  const canonical = parseIssueKey(key).key;
  const record = await ports.issues.findByKey(canonical);
  if (record === null) {
    throw new ServiceError("not_found", `issue "${canonical}" not found`);
  }
  const meta =
    (await ports.meta.loadForIds([record.id])).get(record.id) ?? emptyMeta();
  return toIssue(record, resolved, meta);
}

export interface IssueTimeline {
  issue: Issue;
  events: IssueEvent[];
}

export async function getIssueTimeline(
  ports: TransactionPorts,
  key: string,
  context?: IssueContext,
): Promise<IssueTimeline> {
  const issue = await getIssue(ports, key, context);
  const events = await ports.events.list(issue.id);
  return { issue, events };
}

export interface MoveIssueInput {
  key: string;
  to: string;
  actor?: string;
  agent?: string;
  body?: string;
}

export async function moveIssue(
  ports: Ports,
  input: MoveIssueInput,
): Promise<Issue> {
  const key = parseIssueKey(input.key).key;
  const to = validateStatus(input.to);
  const { actor, agent } = resolveContext({
    actor: input.actor,
    agent: input.agent,
  });
  let claimAgent: string | null = null;
  if (actor === "agent") {
    if (agent === null) {
      throw new ServiceError(
        "validation",
        'actor "agent" requires an agent identity',
      );
    }
    claimAgent = agent;
    if ((await ports.agents.findByName(agent.trim())) === null) {
      throw new ServiceError("not_found", `agent "${agent.trim()}" not found`);
    }
  }
  const body = input.body?.trim() ?? "";

  try {
    return await ports.transaction(async (tx) => {
      const locked = await tx.issues.lockByKey(key);
      if (locked === null) {
        throw new ServiceError("not_found", `issue "${key}" not found`);
      }

      const from = locked.status;
      if (!isLegalTransition(from, to)) {
        throw new ServiceError(
          "illegal_transition",
          `issue "${key}" cannot move from "${from}" to "${to}"`,
        );
      }
      if (!mayMove(actor, agent, from, to, locked.claimedBy)) {
        const who = agent === null ? actor : `${actor} "${agent}"`;
        throw new ServiceError(
          "forbidden_transition",
          `${who} may not move issue "${key}" from "${from}" to "${to}"`,
        );
      }

      const claimedBy = nextClaimedBy(actor, agent, to, locked.claimedBy);
      await tx.issues.updateStatus({ id: locked.id, status: to, claimedBy });
      await tx.events.append({
        issueId: locked.id,
        kind: "status",
        actorType: actor,
        fromStatus: from,
        toStatus: to,
        body: body.length === 0 ? null : body,
      });

      return hydrateIssue(tx, locked.id, { actor, agent });
    });
  } catch (error) {
    if (!(error instanceof ActiveClaimConflict)) {
      throw error;
    }
    if (claimAgent === null) {
      throw error;
    }
    const active = await ports.issues.findActiveClaimKey(claimAgent);
    throw new ServiceError(
      "agent_busy",
      active === null
        ? `agent "${claimAgent}" already holds an active issue`
        : `agent "${claimAgent}" already holds issue "${active}"`,
    );
  }
}
