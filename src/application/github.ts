import { ServiceError } from "../domain/errors.ts";
import { issueKeyFromText } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";
import { moveIssue } from "./issues.ts";
import type { Ports } from "./ports.ts";

/** Narrows an unknown JSON value to a plain object, or null when it is not one. */
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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
  ports: Ports,
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
    return await moveIssue(ports, { key, to, actor: "git", body: summary });
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
