import { allowedTransitions } from "../domain/actors.ts";
import type { ResolvedContext } from "../domain/actors.ts";
import { emptyMeta } from "../domain/types.ts";
import type { Issue, IssueMeta } from "../domain/types.ts";
import type { IssueRecord, TransactionPorts } from "./ports.ts";

/** Projects a stored issue row through the reading actor's context. */
export function toIssue(
  record: IssueRecord,
  context: ResolvedContext,
  meta: IssueMeta = emptyMeta(),
): Issue {
  return {
    id: record.id,
    key: record.key,
    projectId: record.projectId,
    projectKey: record.projectKey,
    number: record.number,
    title: record.title,
    description: record.description,
    status: record.status,
    allowedTransitions: allowedTransitions(record.status, {
      actor: context.actor,
      agent: context.agent,
      claimedBy: record.claimedBy,
    }),
    priority: record.priority,
    parentId: record.parentId,
    blockedReason: record.blockedReason,
    claimedBy: record.claimedBy,
    labels: meta.labels,
    relations: meta.relations,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Reads an issue back by id, projecting it through the caller's context. */
export async function hydrateIssue(
  ports: TransactionPorts,
  id: number,
  context: ResolvedContext,
): Promise<Issue> {
  const record = await ports.issues.findById(id);
  if (record === null) {
    throw new Error(`issue ${id} could not be read back`);
  }
  const meta = (await ports.meta.loadForIds([id])).get(id) ?? emptyMeta();
  return toIssue(record, context, meta);
}
