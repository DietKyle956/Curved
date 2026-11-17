import type { QueryResultRow } from "pg";
import type { Db } from "../db.ts";
import { pgErrorCode } from "../db.ts";
import { ServiceError } from "../domain/errors.ts";
import type { Project } from "../domain/types.ts";
import {
  validateProjectKey,
  validateProjectName,
} from "../domain/validation.ts";

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

export async function createProject(
  db: Db,
  input: { key: string; name: string },
): Promise<Project> {
  const { key } = input;
  validateProjectKey(key);
  const name = validateProjectName(input.name);

  try {
    const row = await db.one<ProjectRow>(
      `insert into projects (key, name)
       values ($1, $2)
       returning id, key, name, next_number, created_at`,
      [key, name],
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
}

export async function listProjects(db: Db): Promise<Project[]> {
  const rows = await db.query<ProjectRow>(
    `select id, key, name, next_number, created_at
     from projects
     order by key asc`,
  );
  return rows.map(toProject);
}
