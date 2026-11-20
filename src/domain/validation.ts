import { ServiceError } from "./errors.ts";
import { PROJECT_KEY_PATTERN } from "./keys.ts";
import {
  PROJECT_STATUSES,
  STATUSES,
  isPriority,
  isProjectStatus,
  isStatus,
} from "./status.ts";
import type { Priority, ProjectStatus, Status } from "./status.ts";

export const TITLE_MAX_LENGTH = 500;
export const PROJECT_NAME_MAX_LENGTH = 200;
export const PROJECT_SUMMARY_MAX_LENGTH = 255;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 20000;
export const AGENT_NAME_MAX_LENGTH = 100;
export const LABEL_NAME_MAX_LENGTH = 50;
export const BLOCKED_REASON_MAX_LENGTH = 2000;
export const PASSKEY_NICKNAME_MAX_LENGTH = 60;

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

/**
 * Trims a project summary. Empty is allowed; only the length is bounded.
 */
export function validateProjectSummary(raw: string): string {
  const summary = raw.trim();
  if (summary.length > PROJECT_SUMMARY_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `project summary must be at most ${PROJECT_SUMMARY_MAX_LENGTH} characters, got ${summary.length}`,
    );
  }
  return summary;
}

/**
 * Project descriptions are plain text, so whitespace is preserved as written;
 * only the length is bounded.
 */
export function validateProjectDescription(raw: string): string {
  if (raw.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `project description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters, got ${raw.length}`,
    );
  }
  return raw;
}

export function validateProjectStatus(raw: string): ProjectStatus {
  if (!isProjectStatus(raw)) {
    throw new ServiceError(
      "validation",
      `project status "${raw}" must be one of: ${PROJECT_STATUSES.join(", ")}`,
    );
  }
  return raw;
}

export function validateProjectPriority(raw: number | null): Priority | null {
  if (raw === null) {
    return null;
  }
  if (!Number.isInteger(raw) || !isPriority(raw)) {
    throw new ServiceError(
      "validation",
      `project priority must be null or an integer between 1 and 4, got "${raw}"`,
    );
  }
  return raw;
}

const PROJECT_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Accepts only a real calendar date written as `YYYY-MM-DD`, so month/day
 * overflow such as `2026-02-31` is rejected rather than coerced by JS dates.
 */
export function validateProjectDate(
  raw: string,
  field: "startDate" | "targetDate",
): string {
  const message = `project ${field} must be a valid ISO date (YYYY-MM-DD), got "${raw}"`;
  const match = typeof raw === "string" ? PROJECT_DATE_PATTERN.exec(raw) : null;
  if (match === null) {
    throw new ServiceError("validation", message);
  }
  const [, year, month, day] = match;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    throw new ServiceError("validation", message);
  }
  return raw;
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

export function validatePasskeyNickname(raw: string): string {
  const nickname = raw.trim();
  if (nickname.length === 0) {
    throw new ServiceError("validation", "passkey nickname must not be empty");
  }
  if (nickname.length > PASSKEY_NICKNAME_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `passkey nickname must be at most ${PASSKEY_NICKNAME_MAX_LENGTH} characters`,
    );
  }
  return nickname;
}
