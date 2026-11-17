import type { QueryResultRow } from "pg";
import type { Database, Db } from "../db.ts";
import { pgErrorConstraint } from "../db.ts";
import {
  allowedTransitions,
  resolveContext,
  validateActor,
} from "../domain/actors.ts";
import type { IssueContext, ResolvedContext } from "../domain/actors.ts";
import { nextClaimedBy } from "../domain/claim.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import { mayMove } from "../domain/move-policy.ts";
import { DEFAULT_PRIORITY, DEFAULT_STATUS } from "../domain/status.ts";
import type { Priority, Status } from "../domain/status.ts";
import { isLegalTransition } from "../domain/transition.ts";
import { emptyMeta } from "../domain/types.ts";
import type { Issue, IssueEvent, IssueMeta } from "../domain/types.ts";
import {
  validatePriority,
  validateProjectKey,
  validateStatus,
  validateTitle,
} from "../domain/validation.ts";
import { appendEvent, listEvents } from "./events.ts";
import { loadIssueMeta } from "./issue-meta.ts";
import { ensureAgentExists } from "./agents.ts";

export interface CreateIssueInput {
  project: string;
  title: string;
  description?: string;
  priority?: number;
  status?: string;
  parent?: string;
  actor?: string;
}

export interface IssueRow extends QueryResultRow {
  id: number;
  project_id: number;
  project_key: string;
  number: number;
  key: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  parent_id: number | null;
  blocked_reason: string | null;
  claimed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const ISSUE_COLUMNS = `i.id, i.project_id, p.key as project_key, i.number, i.key, i.title, i.description,
       i.status, i.priority, i.parent_id, i.blocked_reason, i.claimed_by,
       i.created_at, i.updated_at`;

export function toIssue(
  row: IssueRow,
  context: ResolvedContext,
  meta: IssueMeta = emptyMeta(),
): Issue {
  return {
    id: row.id,
    key: row.key,
    projectId: row.project_id,
    projectKey: row.project_key,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
    allowedTransitions: allowedTransitions(row.status, {
      actor: context.actor,
      agent: context.agent,
      claimedBy: row.claimed_by,
    }),
    priority: row.priority,
    parentId: row.parent_id,
    blockedReason: row.blocked_reason,
    claimedBy: row.claimed_by,
    labels: meta.labels,
    relations: meta.relations,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Reads an issue back by id, projecting it through the caller's context. */
export async function hydrateIssue(
  db: Db,
  id: number,
  context: ResolvedContext,
): Promise<Issue> {
  const row = await db.one<IssueRow>(
    `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where i.id = $1`,
    [id],
  );
  if (row === null) {
    throw new Error(`issue ${id} could not be read back`);
  }
  const meta = (await loadIssueMeta(db, [id])).get(id) ?? emptyMeta();
  return toIssue(row, context, meta);
}

export async function createIssue(
  db: Database,
  input: CreateIssueInput,
): Promise<Issue> {
  const project = validateProjectKey(input.project);
  const title = validateTitle(input.title);
  const description = input.description ?? "";
  const priority = validatePriority(input.priority ?? DEFAULT_PRIORITY);
  const status = validateStatus(input.status ?? DEFAULT_STATUS);
  const actor = validateActor(input.actor ?? "human");

  return db.tx(async (tx) => {
    let parentId: number | null = null;
    if (input.parent !== undefined) {
      const parentKey = parseIssueKey(input.parent).key;
      const parent = await tx.one<{ id: number }>(
        `select id from issues where key = $1`,
        [parentKey],
      );
      if (parent === null) {
        throw new ServiceError(
          "not_found",
          `parent issue "${parentKey}" not found`,
        );
      }
      parentId = parent.id;
    }

    const created = await tx.one<{ id: number }>(
      `with allocated as (
         update projects
         set next_number = next_number + 1
         where key = $1
         returning id, key, next_number - 1 as number
       )
       insert into issues (project_id, number, key, title, description, status, priority, parent_id)
       select allocated.id,
              allocated.number,
              allocated.key || '-' || allocated.number,
              $2, $3, $4, $5, $6
       from allocated
       returning id`,
      [project, title, description, status, priority, parentId],
    );
    if (created === null) {
      throw new ServiceError("not_found", `project "${project}" not found`);
    }

    const row = await tx.one<IssueRow>(
      `select ${ISSUE_COLUMNS}
       from issues i
       join projects p on p.id = i.project_id
       where i.id = $1`,
      [created.id],
    );
    if (row === null) {
      throw new Error("created issue could not be read back");
    }

    const issue = toIssue(row, { actor, agent: null });
    await appendEvent(tx, {
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
  db: Db,
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

  const rows = await db.query<IssueRow>(
    `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where ($1::text is null or p.key = $1)
       and ($2::text is null or i.status = $2)
     order by p.key asc, i.number asc`,
    [project, status],
  );
  if (rows.length > 0) {
    const meta = await loadIssueMeta(db, rows.map((row) => row.id));
    return rows.map((row) =>
      toIssue(row, resolved, meta.get(row.id) ?? emptyMeta()),
    );
  }
  // An empty list may mean an unknown project rather than an empty one.
  if (project !== null) {
    const existing = await db.one<{ id: number }>(
      `select id from projects where key = $1`,
      [project],
    );
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
  db: Database,
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

  return db.tx(async (tx) => {
    const updated = await tx.one<{ id: number }>(
      `update issues i
       set title = coalesce($2, i.title),
           description = coalesce($3, i.description),
           priority = coalesce($4, i.priority),
           updated_at = now()
       where i.key = $1
       returning i.id`,
      [key, title, description, priority],
    );
    if (updated === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    return hydrateIssue(tx, updated.id, { actor: "human", agent: null });
  });
}

export async function getIssue(
  db: Db,
  key: string,
  context?: IssueContext,
): Promise<Issue> {
  const resolved = resolveContext(context);
  const canonical = parseIssueKey(key).key;
  const row = await db.one<IssueRow>(
    `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where i.key = $1`,
    [canonical],
  );
  if (row === null) {
    throw new ServiceError("not_found", `issue "${canonical}" not found`);
  }
  const meta = (await loadIssueMeta(db, [row.id])).get(row.id) ?? emptyMeta();
  return toIssue(row, resolved, meta);
}

export interface IssueTimeline {
  issue: Issue;
  events: IssueEvent[];
}

export async function getIssueTimeline(
  db: Db,
  key: string,
  context?: IssueContext,
): Promise<IssueTimeline> {
  const issue = await getIssue(db, key, context);
  const events = await listEvents(db, issue.id);
  return { issue, events };
}

export interface MoveIssueInput {
  key: string;
  to: string;
  actor?: string;
  agent?: string;
  body?: string;
}

interface LockedIssueRow extends QueryResultRow {
  id: number;
  status: Status;
  claimed_by: string | null;
}

export async function moveIssue(
  db: Database,
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
    await ensureAgentExists(db, agent);
  }
  const body = input.body?.trim() ?? "";

  try {
    return await db.tx(async (tx) => {
      const locked = await tx.one<LockedIssueRow>(
        `select id, status, claimed_by from issues where key = $1 for update`,
        [key],
      );
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
      if (!mayMove(actor, agent, from, to, locked.claimed_by)) {
        const who = agent === null ? actor : `${actor} "${agent}"`;
        throw new ServiceError(
          "forbidden_transition",
          `${who} may not move issue "${key}" from "${from}" to "${to}"`,
        );
      }

      const claimedBy = nextClaimedBy(actor, agent, to, locked.claimed_by);
      await tx.query(
        `update issues set status = $2, claimed_by = $3, updated_at = now() where id = $1`,
        [locked.id, to, claimedBy],
      );
      await appendEvent(tx, {
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
    if (pgErrorConstraint(error) !== "issues_one_active_claim_per_agent") {
      throw error;
    }
    if (claimAgent === null) {
      throw error;
    }
    const active = await db.one<{ key: string }>(
      `select key from issues
       where claimed_by = $1 and status in ('in_progress', 'in_review')
       order by key asc
       limit 1`,
      [claimAgent],
    );
    throw new ServiceError(
      "agent_busy",
      active === null
        ? `agent "${claimAgent}" already holds an active issue`
        : `agent "${claimAgent}" already holds issue "${active.key}"`,
    );
  }
}
