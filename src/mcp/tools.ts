import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { blockIssue } from "../services/blocking.ts";
import { commentOnIssue } from "../services/comments.ts";
import {
  createIssue as createIssueService,
  getIssueTimeline,
} from "../services/issues.ts";
import {
  claimNext as claimNextService,
  listReady as listReadyService,
  releaseClaim as releaseClaimService,
  submitForReview as submitForReviewService,
} from "../services/queue.ts";

const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$/;

export const projectSchema = z
  .string()
  .regex(
    PROJECT_KEY_PATTERN,
    `project key must match ${PROJECT_KEY_PATTERN.source}`,
  );
export const issueKeySchema = z
  .string()
  .regex(ISSUE_KEY_PATTERN, `issue key must match ${ISSUE_KEY_PATTERN.source}`);
export const titleSchema = z.string().min(1).max(500);
export const descriptionSchema = z.string();
export const prioritySchema = z.number().int().min(1).max(4);
export const commentBodySchema = z.string().min(1);
export const summarySchema = z.string().min(1);
export const blockReasonSchema = z.string().min(1);

export const claimNextInput = z.object({
  project: projectSchema.optional(),
});
export const commentInput = z.object({
  key: issueKeySchema,
  body: commentBodySchema,
});
export const createIssueInput = z.object({
  project: projectSchema,
  title: titleSchema,
  description: descriptionSchema.optional(),
  priority: prioritySchema.optional(),
});
export const getIssueInput = z.object({
  key: issueKeySchema,
});
export const listReadyInput = z.object({
  project: projectSchema.optional(),
});
export const markBlockedInput = z.object({
  key: issueKeySchema,
  reason: blockReasonSchema,
});
export const releaseClaimInput = z.object({
  key: issueKeySchema,
});
export const submitForReviewInput = z.object({
  key: issueKeySchema,
  summary: summarySchema,
});

export type ClaimNextInput = z.infer<typeof claimNextInput>;
export type CommentInput = z.infer<typeof commentInput>;
export type CreateIssueInput = z.infer<typeof createIssueInput>;
export type GetIssueInput = z.infer<typeof getIssueInput>;
export type ListReadyInput = z.infer<typeof listReadyInput>;
export type MarkBlockedInput = z.infer<typeof markBlockedInput>;
export type ReleaseClaimInput = z.infer<typeof releaseClaimInput>;
export type SubmitForReviewInput = z.infer<typeof submitForReviewInput>;

export interface ToolDeps {
  db: Database;
  /** Resolves the authenticated agent name, or throws `not_authenticated`. */
  resolveAgent(): Promise<string>;
}

export function textResult<T>(payload: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorResult(error: ServiceError): CallToolResult {
  return {
    content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    isError: true,
  };
}

/**
 * Runs a tool body, rendering `ServiceError` as an `isError` text result.
 * Anything else is a bug and is rethrown for the transport to report.
 */
export async function runTool<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return textResult(await fn());
  } catch (error) {
    if (error instanceof ServiceError) {
      return errorResult(error);
    }
    throw error;
  }
}

export async function claimNext(deps: ToolDeps, input: ClaimNextInput) {
  const agent = await deps.resolveAgent();
  const issue = await claimNextService(
    deps.db,
    { project: input.project },
    agent,
  );
  return getIssueTimeline(deps.db, issue.key, { actor: "agent", agent });
}

export async function comment(deps: ToolDeps, input: CommentInput) {
  const agent = await deps.resolveAgent();
  return commentOnIssue(deps.db, {
    key: input.key,
    body: input.body,
    actor: "agent",
    agent,
  });
}

export async function createIssue(deps: ToolDeps, input: CreateIssueInput) {
  await deps.resolveAgent();
  return createIssueService(deps.db, {
    project: input.project,
    title: input.title,
    description: input.description,
    priority: input.priority,
    actor: "agent",
  });
}

export async function getIssue(deps: ToolDeps, input: GetIssueInput) {
  const agent = await deps.resolveAgent();
  return getIssueTimeline(deps.db, input.key, { actor: "agent", agent });
}

export async function listReady(deps: ToolDeps, input: ListReadyInput) {
  const agent = await deps.resolveAgent();
  return listReadyService(
    deps.db,
    { project: input.project },
    { actor: "agent", agent },
  );
}

export async function markBlocked(deps: ToolDeps, input: MarkBlockedInput) {
  const agent = await deps.resolveAgent();
  return blockIssue(deps.db, {
    key: input.key,
    agent,
    reason: input.reason,
  });
}

export async function releaseClaim(deps: ToolDeps, input: ReleaseClaimInput) {
  const agent = await deps.resolveAgent();
  return releaseClaimService(deps.db, { key: input.key, agent });
}

export async function submitForReview(
  deps: ToolDeps,
  input: SubmitForReviewInput,
) {
  const agent = await deps.resolveAgent();
  return submitForReviewService(deps.db, {
    key: input.key,
    agent,
    summary: input.summary,
  });
}
