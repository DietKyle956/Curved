import type { QueryResultRow } from "pg";
import type { Db } from "../../../db.ts";
import { pgErrorConstraint } from "../../../db.ts";
import type {
  IssueRecord,
  IssueRepository,
  LockedIssueRecord,
} from "../../../application/ports.ts";
import { ActiveClaimConflict } from "../../../application/ports.ts";
import type { Priority, Status } from "../../../domain/status.ts";

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

interface LockedIssueRow extends QueryResultRow {
  id: number;
  status: Status;
  claimed_by: string | null;
  blocked_reason: string | null;
}

interface IdRow extends QueryResultRow {
  id: number;
}

interface KeyRow extends QueryResultRow {
  key: string;
}

const ISSUE_COLUMNS = `i.id, i.project_id, p.key as project_key, i.number, i.key, i.title, i.description,
       i.status, i.priority, i.parent_id, i.blocked_reason, i.claimed_by,
       i.created_at, i.updated_at`;

function toRecord(row: IssueRow): IssueRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    number: row.number,
    key: row.key,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    parentId: row.parent_id,
    blockedReason: row.blocked_reason,
    claimedBy: row.claimed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLockedRecord(row: LockedIssueRow): LockedIssueRecord {
  return {
    id: row.id,
    status: row.status,
    claimedBy: row.claimed_by,
    blockedReason: row.blocked_reason,
  };
}

export function createIssueRepository(db: Db): IssueRepository {
  return {
    async create(input): Promise<IssueRecord | null> {
      const created = await db.one<IdRow>(
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
        [
          input.projectKey,
          input.title,
          input.description,
          input.status,
          input.priority,
          input.parentId,
        ],
      );
      if (created === null) {
        return null;
      }

      const row = await db.one<IssueRow>(
        `select ${ISSUE_COLUMNS}
       from issues i
       join projects p on p.id = i.project_id
       where i.id = $1`,
        [created.id],
      );
      if (row === null) {
        throw new Error("created issue could not be read back");
      }
      return toRecord(row);
    },

    async findById(id: number): Promise<IssueRecord | null> {
      const row = await db.one<IssueRow>(
        `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where i.id = $1`,
        [id],
      );
      return row === null ? null : toRecord(row);
    },

    async findByKey(key: string): Promise<IssueRecord | null> {
      const row = await db.one<IssueRow>(
        `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where i.key = $1`,
        [key],
      );
      return row === null ? null : toRecord(row);
    },

    async lockByKey(key: string): Promise<LockedIssueRecord | null> {
      const row = await db.one<LockedIssueRow>(
        `select id, status, claimed_by, blocked_reason from issues where key = $1 for update`,
        [key],
      );
      return row === null ? null : toLockedRecord(row);
    },

    async list(filter): Promise<IssueRecord[]> {
      const rows = await db.query<IssueRow>(
        `select ${ISSUE_COLUMNS}
     from issues i
     join projects p on p.id = i.project_id
     where ($1::text is null or p.key = $1)
       and ($2::text is null or i.status = $2)
     order by p.key asc, i.number asc`,
        [filter.project, filter.status],
      );
      return rows.map(toRecord);
    },

    async updateFields(input): Promise<{ id: number } | null> {
      const updated = await db.one<IdRow>(
        `update issues i
       set title = coalesce($2, i.title),
           description = coalesce($3, i.description),
           priority = coalesce($4, i.priority),
           updated_at = now()
       where i.key = $1
       returning i.id`,
        [input.key, input.title, input.description, input.priority],
      );
      return updated === null ? null : { id: updated.id };
    },

    async updateStatus(input): Promise<void> {
      try {
        await db.query(
          `update issues set status = $2, claimed_by = $3, updated_at = now() where id = $1`,
          [input.id, input.status, input.claimedBy],
        );
      } catch (error) {
        if (pgErrorConstraint(error) === "issues_one_active_claim_per_agent") {
          throw new ActiveClaimConflict();
        }
        throw error;
      }
    },

    async findActiveClaimKey(agent: string): Promise<string | null> {
      const row = await db.one<KeyRow>(
        `select key from issues
       where claimed_by = $1 and status in ('in_progress', 'in_review')
       order by key asc
       limit 1`,
        [agent],
      );
      return row === null ? null : row.key;
    },

    async listReady(filter): Promise<IssueRecord[]> {
      const rows = await db.query<IssueRow>(
        `select ${ISSUE_COLUMNS}
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
     order by i.priority asc, i.number asc, i.key asc`,
        [filter.project],
      );
      return rows.map(toRecord);
    },
  };
}
