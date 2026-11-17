import type { QueryResultRow } from "pg";
import type { Db } from "../../../db.ts";
import { pgErrorCode } from "../../../db.ts";
import type { ProjectRepository } from "../../../application/ports.ts";
import { ServiceError } from "../../../domain/errors.ts";
import type { Project } from "../../../domain/types.ts";

interface ProjectRow extends QueryResultRow {
  id: number;
  key: string;
  name: string;
  next_number: number;
  created_at: Date;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    nextNumber: row.next_number,
    createdAt: row.created_at.toISOString(),
  };
}

export function createProjectRepository(db: Db): ProjectRepository {
  return {
    async create(input: { key: string; name: string }): Promise<Project> {
      const { key } = input;
      try {
        const row = await db.one<ProjectRow>(
          `insert into projects (key, name)
           values ($1, $2)
           returning id, key, name, next_number, created_at`,
          [key, input.name],
        );
        if (row === null) {
          throw new Error("project insert returned no row");
        }
        return toProject(row);
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

    async list(): Promise<Project[]> {
      const rows = await db.query<ProjectRow>(
        `select id, key, name, next_number, created_at
         from projects
         order by key asc`,
      );
      return rows.map(toProject);
    },

    async findByKey(key: string): Promise<Project | null> {
      const row = await db.one<ProjectRow>(
        `select id, key, name, next_number, created_at
         from projects
         where key = $1`,
        [key],
      );
      return row === null ? null : toProject(row);
    },
  };
}
