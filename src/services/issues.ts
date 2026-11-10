import type { QueryResultRow } from "pg";
import type { Database, Db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  STATUSES,
  actorMayTransition,
  allowedTransitions,
  isActorType,
  isLegalTransition,
  isPriority,
  isStatus,
} from "../shared/status.ts";
import type { ActorType, Priority, Status } from "../shared/status.ts";
import { appendEvent, listEvents } from "./events.ts";
import type { IssueEvent } from "./events.ts";

const ISSUE_KEY_PATTERN = /^([A-Z][A-Z0-9]{1,9})-([0-9]{1,6})$/;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const TITLE_MAX_LENGTH = 500;

export interface Issue {
  id: number;
  key: string;
  projectId: number;
  projectKey: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  /** Transitions the reading actor may take from `status` right now. */
  allowedTransitions: Status[];
  priority: Priority;
  parentId: number | null;
  blockedReason: string | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIssueInput {
  project: string;
  title: string;
  description?: string;
  priority?: number;
  status?: string;
  parent?: string;
  actor?: string;
}

/**
 * Who is reading an issue. `actor` defaults to `human`; `agent` names the
 * agent identity and is only valid alongside `actor: "agent"`.
 */
export interface IssueContext {
  actor?: string;
  agent?: string;
}

interface ResolvedContext {
  actor: ActorType;
  agent: string | null;
}

function resolveContext(context?: IssueContext): ResolvedContext {
  const actor = validateActor(context?.actor ?? "human");
  if (context?.agent === undefined) {
    return { actor, agent: null };
  }
  const agent = context.agent.trim();
  if (agent.length === 0) {
    throw new ServiceError("validation", "agent identity must not be empty");
  }
  if (actor !== "agent") {
    throw new ServiceError(
      "validation",
      `agent identity "${agent}" requires actor "agent", got "${actor}"`,
    );
  }
  return { actor, agent };
}

interface IssueRow extends QueryResultRow {
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

const ISSUE_COLUMNS = `i.id, i.project_id, p.key as project_key, i.number, i.key, i.title, i.description,
       i.status, i.priority, i.parent_id, i.blocked_reason, i.claimed_by,
       i.created_at, i.updated_at`;

function toIssue(row: IssueRow, context: ResolvedContext): Issue {
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
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function parseIssueKey(input: string): {
  project: string;
  number: number;
  key: string;
} {
  const match = ISSUE_KEY_PATTERN.exec(input);
  if (match === null) {
    throw new ServiceError(
      "validation",
      `issue key "${input}" must match ${ISSUE_KEY_PATTERN.source}`,
    );
  }
  const project = match[1] ?? "";
  const number = Number(match[2] ?? "");
  if (number < 1) {
    throw new ServiceError(
      "validation",
      `issue key "${input}" must have a number of at least 1, got ${number}`,
    );
  }
  return { project, number, key: `${project}-${number}` };
}

function validateProjectKey(raw: string): string {
  if (!PROJECT_KEY_PATTERN.test(raw)) {
    throw new ServiceError(
      "validation",
      `project key "${raw}" must match ${PROJECT_KEY_PATTERN.source}`,
    );
  }
  return raw;
}

function validateTitle(raw: string): string {
  const title = raw.trim();
  if (title.length === 0) {
    throw new ServiceError("validation", "issue title must not be empty");
  }
  if (title.length > TITLE_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `issue title must be at most ${TITLE_MAX_LENGTH} characters, got ${title.length}`,
    );
  }
  return title;
}

function validatePriority(raw: number): Priority {
  if (!Number.isInteger(raw) || !isPriority(raw)) {
    throw new ServiceError(
      "validation",
      `issue priority must be an integer between 1 and 4, got "${raw}"`,
    );
  }
  return raw;
}

function validateStatus(raw: string): Status {
  if (!isStatus(raw)) {
    throw new ServiceError(
      "validation",
      `issue status "${raw}" must be one of: ${STATUSES.join(", ")}`,
    );
  }
  return raw;
}

export function validateActor(raw: string): ActorType {
  if (!isActorType(raw)) {
    throw new ServiceError(
      "validation",
      `actor type "${raw}" must be one of: agent, human, git, system`,
    );
  }
  return raw;
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
  filter?: { project?: string },
  context?: IssueContext,
): Promise<Issue[]> {
  const resolved = resolveContext(context);
  let project: string | null = null;
  if (filter?.project !== undefined) {
    project = validateProjectKey(filter.project);
    const existing = await db.one<{ id: number }>(
      `select id from projects where key = $1`,
      [project],
    );
    if (existing === null) {
      throw new ServiceError("not_found", `project "${project}" not found`);
    }
  }

  const rows = await db.query<IssueRow>(
    `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where $1::text is null or p.key = $1
     order by p.key asc, i.number asc`,
    [project],
  );
  return rows.map((row) => toIssue(row, resolved));
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
  return toIssue(row, resolved);
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

/**
 * Whether a legal edge may be taken by this actor with this ownership.
 * The legal-edge gate runs first; this gate is strictly about authority.
 */
function mayMove(
  actor: ActorType,
  agent: string | null,
  from: Status,
  to: Status,
  claimedBy: string | null,
): boolean {
  if (actor === "human") {
    return true;
  }
  if (actor === "agent") {
    if (from === "todo" && to === "in_progress" && claimedBy === null) {
      return agent !== null;
    }
    return (
      agent !== null &&
      claimedBy !== null &&
      claimedBy === agent &&
      actorMayTransition("agent", from, to)
    );
  }
  if (actor === "system") {
    return false;
  }
  return actorMayTransition(actor, from, to);
}

/**
 * The claim column after a move: leaving for the backlog clears it, an agent
 * claiming into `in_progress` takes it, and every other target keeps it.
 */
function nextClaimedBy(
  actor: ActorType,
  agent: string | null,
  to: Status,
  current: string | null,
): string | null {
  if (to === "todo" || to === "backlog") {
    return null;
  }
  if (to === "in_progress" && actor === "agent") {
    return agent;
  }
  return current;
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
  if (actor === "agent" && agent === null) {
    throw new ServiceError(
      "validation",
      'actor "agent" requires an agent identity',
    );
  }
  const body = input.body?.trim() ?? "";

  return db.tx(async (tx) => {
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

    const row = await tx.one<IssueRow>(
      `select ${ISSUE_COLUMNS}
       from issues i
       join projects p on p.id = i.project_id
       where i.id = $1`,
      [locked.id],
    );
    if (row === null) {
      throw new Error("moved issue could not be read back");
    }
    return toIssue(row, { actor, agent });
  });
}
