import type { QueryResultRow } from "pg";
import type { Db } from "../db.ts";
import { pgErrorCode } from "../db.ts";
import { ServiceError } from "../errors.ts";

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const NAME_MAX_LENGTH = 200;

export interface Project {
  id: number;
  key: string;
  name: string;
  nextNumber: number;
  createdAt: string;
}

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

function validateName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ServiceError("validation", "project name must not be empty");
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `project name must be at most ${NAME_MAX_LENGTH} characters, got ${name.length}`,
    );
  }
  return name;
}

export async function createProject(
  db: Db,
  input: { key: string; name: string },
): Promise<Project> {
  const { key } = input;
  if (!KEY_PATTERN.test(key)) {
    throw new ServiceError(
      "validation",
      `project key "${key}" must match ${KEY_PATTERN.source}`,
    );
  }
  const name = validateName(input.name);

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
