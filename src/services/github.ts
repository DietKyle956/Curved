import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { moveIssue, parseIssueKey } from "./issues.ts";
import type { Issue } from "./issues.ts";

const ISSUE_KEY_IN_TEXT =
  /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-([0-9]{1,6})(?![A-Za-z0-9])/;
const BRANCH_SLUG_MAX_LENGTH = 60;

/** Narrows an unknown JSON value to a plain object, or null when it is not one. */
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

/** The status a pull request action targets, or null when it moves nothing. */
function targetForAction(
  action: unknown,
  merged: unknown,
): "in_review" | "done" | null {
  if (action === "opened" || action === "reopened") {
    return "in_review";
  }
  if (action === "closed") {
    return merged === true ? "done" : null;
  }
  return null;
}

/**
 * Applies a GitHub `pull_request` event to the matching issue. Returns null for
 * anything ignored, including replays: re-moving to the same status is an
 * illegal transition, so it resolves to null instead of an error.
 */
export async function applyPullRequestEvent(
  db: Database,
  event: string | null,
  payload: unknown,
): Promise<Issue | null> {
  if (event !== "pull_request") {
    return null;
  }
  const body = record(payload);
  if (body === null) {
    return null;
  }
  const pullRequest = record(body["pull_request"]);
  if (pullRequest === null) {
    return null;
  }
  const topAction = body["action"];
  const nestedAction = pullRequest["action"];
  const action =
    typeof topAction === "string"
      ? topAction
      : typeof nestedAction === "string"
        ? nestedAction
        : null;
  const to = targetForAction(action, pullRequest["merged"]);
  if (to === null) {
    return null;
  }

  const head = record(pullRequest["head"]);
  const ref = head === null ? "" : head["ref"];
  const title = pullRequest["title"];
  const key =
    issueKeyFromText(typeof ref === "string" ? ref : "") ??
    issueKeyFromText(typeof title === "string" ? title : "");
  if (key === null) {
    return null;
  }

  const topNumber = body["number"];
  const number =
    typeof topNumber === "number" ? topNumber : pullRequest["number"];
  const summary =
    typeof number === "number"
      ? `pull request #${number} ${String(action)}`
      : `pull request ${String(action)}`;

  try {
    return await moveIssue(db, { key, to, actor: "git", body: summary });
  } catch (error) {
    if (
      error instanceof ServiceError &&
      (error.code === "not_found" ||
        error.code === "illegal_transition" ||
        error.code === "forbidden_transition")
    ) {
      return null;
    }
    throw error;
  }
}
