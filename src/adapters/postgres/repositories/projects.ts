import type { QueryResultRow } from "pg";
import type { Db } from "../pool.ts";
import { pgErrorCode } from "../pool.ts";
import type { ProjectRepository } from "../../../application/ports.ts";
import { ServiceError } from "../../../domain/errors.ts";
import type { Priority, ProjectStatus } from "../../../domain/status.ts";
import { emptyProgress } from "../../../domain/types.ts";
import type { Project, ProjectProgress, ProjectWithProgress } from "../../../domain/types.ts";

/** Plain project columns; dates are cast to text so pg never builds Date values. */
const PROJECT_COLUMNS = `p.id, p.key, p.name, p.summary, p.description, p.status, p.priority,
       p.start_date::text as start_date, p.target_date::text as target_date,
       p.archived_at, p.next_number, p.created_at, p.updated_at`;

/** Per-project issue counts, correlated on the outer `projects p` row. */
const PROGRESS_COUNTS = `cross join lateral (
         select count(*)::int as total,
                count(*) filter (where i.status = 'backlog')::int as backlog,
                count(*) filter (where i.status = 'todo')::int as todo,
                count(*) filter (where i.status = 'in_progress')::int as in_progress,
                count(*) filter (where i.status = 'in_review')::int as in_review,
                count(*) filter (where i.status = 'done')::int as done
         from issues i
         where i.project_id = p.id
       ) c`;

interface ProjectRow extends QueryResultRow {
  id: number;
  key: string;
  name: string;
  summary: string;
  description: string;
  status: ProjectStatus;
  priority: Priority | null;
  start_date: string | null;
  target_date: string | null;
  archived_at: Date | null;
  next_number: number;
  created_at: Date;
  updated_at: Date;
}

interface ProjectProgressRow extends ProjectRow {
  total: number;
  backlog: number;
  todo: number;
  in_progress: number;
  in_review: number;
  done: number;
}

interface IdRow extends QueryResultRow {
  id: number;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    summary: row.summary,
    description: row.description,
    status: row.status,
    priority: row.priority,
    startDate: row.start_date,
    targetDate: row.target_date,
    archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
    nextNumber: row.next_number,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toProgress(row: ProjectProgressRow): ProjectProgress {
  return {
    total: row.total,
    done: row.done,
    byStatus: {
      backlog: row.backlog,
      todo: row.todo,
      in_progress: row.in_progress,
      in_review: row.in_review,
      done: row.done,
    },
  };
}

function toProjectWithProgress(row: ProjectProgressRow): ProjectWithProgress {
  return { ...toProject(row), progress: toProgress(row) };
}

export function createProjectRepository(db: Db): ProjectRepository {
  async function findWithProgressByKey(
    key: string,
  ): Promise<ProjectWithProgress | null> {
    const row = await db.one<ProjectProgressRow>(
      `select ${PROJECT_COLUMNS},
              c.total, c.backlog, c.todo, c.in_progress, c.in_review, c.done
       from projects p
       ${PROGRESS_COUNTS}
       where p.key = $1`,
      [key],
    );
    return row === null ? null : toProjectWithProgress(row);
  }

  return {
    async create(input): Promise<ProjectWithProgress> {
      const { key } = input;
      try {
        const row = await db.one<ProjectRow>(
          `insert into projects as p
             (key, name, summary, description, status, priority, start_date, target_date)
           values ($1, $2, $3, $4, $5, $6, $7::date, $8::date)
           returning ${PROJECT_COLUMNS}`,
          [
            key,
            input.name,
            input.summary,
            input.description,
            input.status,
            input.priority,
            input.startDate,
            input.targetDate,
          ],
        );
        if (row === null) {
          throw new Error("project insert returned no row");
        }
        return { ...toProject(row), progress: emptyProgress() };
      } catch (error) {
        if (pgErrorCode(error) === "23505") {
          throw new ServiceError(
            "duplicate",
            `project key "${key}" already exists`,
          );
        }
        throw error;
      }
    },

    async list(input): Promise<ProjectWithProgress[]> {
      const rows = await db.query<ProjectProgressRow>(
        `select ${PROJECT_COLUMNS},
                c.total, c.backlog, c.todo, c.in_progress, c.in_review, c.done
         from projects p
         ${PROGRESS_COUNTS}
         where ($1::boolean or p.archived_at is null)
         order by p.key asc`,
        [input.includeArchived],
      );
      return rows.map(toProjectWithProgress);
    },

    async findByKey(key: string): Promise<Project | null> {
      const row = await db.one<ProjectRow>(
        `select ${PROJECT_COLUMNS}
         from projects p
         where p.key = $1`,
        [key],
      );
      return row === null ? null : toProject(row);
    },

    findWithProgressByKey,

    async update(input): Promise<ProjectWithProgress | null> {
      const updated = await db.one<IdRow>(
        `update projects p
         set name = coalesce($2, p.name),
             summary = coalesce($3, p.summary),
             description = coalesce($4, p.description),
             status = coalesce($5, p.status),
             priority = case when $6::boolean then $7::integer else p.priority end,
             start_date = case when $8::boolean then $9::date else p.start_date end,
             target_date = case when $10::boolean then $11::date else p.target_date end,
             archived_at = case when $12::boolean
               then (case when $13::boolean then now() else null end)
               else p.archived_at end,
             updated_at = now()
         where p.key = $1
         returning p.id`,
        [
          input.key,
          input.name ?? null,
          input.summary ?? null,
          input.description ?? null,
          input.status ?? null,
          input.priority !== undefined,
          input.priority ?? null,
          input.startDate !== undefined,
          input.startDate ?? null,
          input.targetDate !== undefined,
          input.targetDate ?? null,
          input.archived !== undefined,
          input.archived === true,
        ],
      );
      if (updated === null) {
        return null;
      }
      return findWithProgressByKey(input.key);
    },
  };
}
