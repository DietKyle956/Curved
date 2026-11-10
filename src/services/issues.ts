import type { QueryResultRow } from "pg";
import type { Database, Db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  STATUSES,
  isActorType,
  isPriority,
  isStatus,
} from "../shared/status.ts";
import type { ActorType, Priority, Status } from "../shared/status.ts";
import { appendEvent } from "./events.ts";

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

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    key: row.key,
    projectId: row.project_id,
    projectKey: row.project_key,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status,
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

function validateActor(raw: string): ActorType {
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

    const issue = toIssue(row);
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
): Promise<Issue[]> {
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
  return rows.map(toIssue);
}

export async function getIssue(db: Db, key: string): Promise<Issue> {
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
  return toIssue(row);
}
