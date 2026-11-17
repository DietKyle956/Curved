import { ServiceError } from "./errors.ts";
import { PROJECT_KEY_PATTERN } from "./keys.ts";
import { STATUSES, isPriority, isStatus } from "./status.ts";
import type { Priority, Status } from "./status.ts";

export const TITLE_MAX_LENGTH = 500;
export const PROJECT_NAME_MAX_LENGTH = 200;
export const AGENT_NAME_MAX_LENGTH = 100;
export const LABEL_NAME_MAX_LENGTH = 50;
export const BLOCKED_REASON_MAX_LENGTH = 2000;

export function validateProjectKey(raw: string): string {
  if (!PROJECT_KEY_PATTERN.test(raw)) {
    throw new ServiceError(
      "validation",
      `project key "${raw}" must match ${PROJECT_KEY_PATTERN.source}`,
    );
  }
  return raw;
}

export function validateTitle(raw: string): string {
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

export function validatePriority(raw: number): Priority {
  if (!Number.isInteger(raw) || !isPriority(raw)) {
    throw new ServiceError(
      "validation",
      `issue priority must be an integer between 1 and 4, got "${raw}"`,
    );
  }
  return raw;
}

export function validateStatus(raw: string): Status {
  if (!isStatus(raw)) {
    throw new ServiceError(
      "validation",
      `issue status "${raw}" must be one of: ${STATUSES.join(", ")}`,
    );
  }
  return raw;
}

export function validateProjectName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ServiceError("validation", "project name must not be empty");
  }
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters, got ${name.length}`,
    );
  }
  return name;
}

export function validateAgentName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ServiceError("validation", "agent name must not be empty");
  }
  if (name.length > AGENT_NAME_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `agent name must be at most ${AGENT_NAME_MAX_LENGTH} characters, got ${name.length}`,
    );
  }
  return name;
}

/**
 * Normalizes a label set: every name must be a string, trims to a non-empty
 * name of at most `LABEL_NAME_MAX_LENGTH` characters, and duplicates collapse.
 * The result is sorted so the event body is deterministic.
 */
export function normalizeLabels(raw: readonly string[]): string[] {
  if (!Array.isArray(raw)) {
    throw new ServiceError("validation", "labels must be an array of strings");
  }
  const names = new Set<string>();
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string") {
      throw new ServiceError(
        "validation",
        `label at index ${index} must be a string`,
      );
    }
    const name = value.trim();
    if (name.length === 0) {
      throw new ServiceError("validation", `label at index ${index} is empty`);
    }
    if (name.length > LABEL_NAME_MAX_LENGTH) {
      throw new ServiceError(
        "validation",
        `label must be at most ${LABEL_NAME_MAX_LENGTH} characters, got ${name.length}`,
      );
    }
    names.add(name);
  }
  return [...names].sort();
}

export function validateBlockReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new ServiceError("validation", "blocked reason must not be empty");
  }
  if (trimmed.length > BLOCKED_REASON_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `blocked reason must be at most ${BLOCKED_REASON_MAX_LENGTH} characters, got ${trimmed.length}`,
    );
  }
  return trimmed;
}

export function validateCommentBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new ServiceError("validation", "comment body must not be empty");
  }
  return trimmed;
}

export function validateReviewSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    throw new ServiceError("validation", "review summary must not be empty");
  }
  return trimmed;
}
