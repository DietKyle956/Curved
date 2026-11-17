import { ServiceError } from "./errors.ts";

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const ISSUE_KEY_PATTERN = /^([A-Z][A-Z0-9]{1,9})-([0-9]{1,6})$/;
export const ISSUE_KEY_IN_TEXT =
  /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-([0-9]{1,6})(?![A-Za-z0-9])/;
export const BRANCH_SLUG_MAX_LENGTH = 60;

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

/**
 * Finds the first issue key in free text, such as a branch name. Returns the
 * canonical form (`TAC-014` -> `TAC-14`), or null when there is no match.
 */
export function issueKeyFromText(input: string): string | null {
  const match = ISSUE_KEY_IN_TEXT.exec(input);
  if (match === null) {
    return null;
  }
  const project = match[1];
  const digits = match[2];
  if (project === undefined || digits === undefined) {
    return null;
  }
  return `${project}-${Number(digits)}`;
}

/** Builds `<canonical-key>-<title-slug>` for an issue branch. */
export function branchNameForIssue(key: string, title: string): string {
  const canonical = parseIssueKey(key).key;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, BRANCH_SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug.length === 0 ? canonical : `${canonical}-${slug}`;
}
