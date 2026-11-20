import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { DEFAULT_PROJECT_STATUS } from "../domain/status.ts";
import type { ProjectWithProgress } from "../domain/types.ts";
import {
  validateProjectDate,
  validateProjectDescription,
  validateProjectKey,
  validateProjectName,
  validateProjectPriority,
  validateProjectStatus,
  validateProjectSummary,
} from "../domain/validation.ts";
import type { Ports, TransactionPorts } from "./ports.ts";

export interface CreateProjectInput {
  key: string;
  name: string;
  summary?: string;
  description?: string;
  status?: string;
  priority?: number | null;
  startDate?: string | null;
  targetDate?: string | null;
}

/**
 * Creates a project. Status starts at `planned` unless given; priority and
 * dates start empty. Field validation lives here, the duplicate-key check in
 * the repository.
 */
export async function createProject(
  ports: TransactionPorts,
  input: CreateProjectInput,
): Promise<ProjectWithProgress> {
  const key = validateProjectKey(input.key);
  const name = validateProjectName(input.name);
  const summary = validateProjectSummary(input.summary ?? "");
  const description = validateProjectDescription(input.description ?? "");
  const status =
    input.status === undefined
      ? DEFAULT_PROJECT_STATUS
      : validateProjectStatus(input.status);
  const priority =
    input.priority === undefined ? null : validateProjectPriority(input.priority);
  const startDate =
    input.startDate === undefined || input.startDate === null
      ? null
      : validateProjectDate(input.startDate, "startDate");
  const targetDate =
    input.targetDate === undefined || input.targetDate === null
      ? null
      : validateProjectDate(input.targetDate, "targetDate");

  return ports.projects.create({
    key,
    name,
    summary,
    description,
    status,
    priority,
    startDate,
    targetDate,
  });
}

/** Lists projects ordered by key, excluding archived ones by default. */
export async function listProjects(
  ports: TransactionPorts,
  options?: { includeArchived?: boolean },
): Promise<ProjectWithProgress[]> {
  return ports.projects.list({
    includeArchived: options?.includeArchived === true,
  });
}

/** Reads one project with its issue progress; unknown keys are not found. */
export async function getProject(
  ports: TransactionPorts,
  key: string,
): Promise<ProjectWithProgress> {
  const project = await ports.projects.findWithProgressByKey(key);
  if (project === null) {
    throw new ServiceError("not_found", `project "${key}" not found`);
  }
  return project;
}

export interface UpdateProjectInput {
  key: string;
  name?: string;
  summary?: string;
  description?: string;
  status?: string;
  priority?: number | null;
  startDate?: string | null;
  targetDate?: string | null;
  archived?: boolean;
  actor?: string;
  agent?: string;
}

/**
 * Edits a project's mutable fields; `null` clears priority or a date, and
 * `priority: null` is distinct from an absent key. Only humans may edit.
 * Project status is not a state machine, so any of the six values is accepted.
 */
export async function updateProject(
  ports: Ports,
  input: UpdateProjectInput,
): Promise<ProjectWithProgress> {
  const { actor } = resolveContext({ actor: input.actor, agent: input.agent });
  if (actor !== "human") {
    throw new ServiceError(
      "forbidden_transition",
      `actor "${actor}" may not edit project "${input.key}"`,
    );
  }
  if (
    input.name === undefined &&
    input.summary === undefined &&
    input.description === undefined &&
    input.status === undefined &&
    input.priority === undefined &&
    input.startDate === undefined &&
    input.targetDate === undefined &&
    input.archived === undefined
  ) {
    throw new ServiceError(
      "validation",
      "at least one project field is required",
    );
  }

  const name = input.name === undefined ? undefined : validateProjectName(input.name);
  const summary =
    input.summary === undefined ? undefined : validateProjectSummary(input.summary);
  const description =
    input.description === undefined
      ? undefined
      : validateProjectDescription(input.description);
  const status =
    input.status === undefined ? undefined : validateProjectStatus(input.status);
  const priority =
    input.priority === undefined
      ? undefined
      : validateProjectPriority(input.priority);
  const startDate =
    input.startDate === undefined
      ? undefined
      : input.startDate === null
        ? null
        : validateProjectDate(input.startDate, "startDate");
  const targetDate =
    input.targetDate === undefined
      ? undefined
      : input.targetDate === null
        ? null
        : validateProjectDate(input.targetDate, "targetDate");

  return ports.transaction(async (tx) => {
    const updated = await tx.projects.update({
      key: input.key,
      name,
      summary,
      description,
      status,
      priority,
      startDate,
      targetDate,
      archived: input.archived,
    });
    if (updated === null) {
      throw new ServiceError("not_found", `project "${input.key}" not found`);
    }
    return updated;
  });
}
