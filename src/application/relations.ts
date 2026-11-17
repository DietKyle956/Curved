import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";
import { hydrateIssue } from "./issue-read-model.ts";
import type { Ports } from "./ports.ts";

export interface AddRelationInput {
  blocked: string;
  blocking: string;
  actor?: string;
  agent?: string;
}

/**
 * Records that one issue blocks another. Only a human may add a relation.
 * The edge is idempotent: a duplicate add writes no second event.
 */
export async function addRelation(
  ports: Ports,
  input: AddRelationInput,
): Promise<Issue> {
  const context = resolveContext({ actor: input.actor, agent: input.agent });
  if (context.actor !== "human") {
    throw new ServiceError(
      "forbidden_transition",
      `actor "${context.actor}" may not add a relation to issue "${input.blocked}"`,
    );
  }

  const blockedKey = parseIssueKey(input.blocked).key;
  const blockingKey = parseIssueKey(input.blocking).key;
  if (blockedKey === blockingKey) {
    throw new ServiceError(
      "validation",
      `issue "${blockedKey}" cannot block itself`,
    );
  }

  const blocked = await ports.issues.findByKey(blockedKey);
  if (blocked === null) {
    throw new ServiceError("not_found", `issue "${blockedKey}" not found`);
  }
  const blocking = await ports.issues.findByKey(blockingKey);
  if (blocking === null) {
    throw new ServiceError("not_found", `issue "${blockingKey}" not found`);
  }

  return ports.transaction(async (tx) => {
    const inserted = await tx.relations.add({
      blockingIssueId: blocking.id,
      blockedIssueId: blocked.id,
    });
    if (inserted) {
      await tx.events.append({
        issueId: blocked.id,
        kind: "relation",
        actorType: "human",
        fromStatus: null,
        toStatus: null,
        body: JSON.stringify({ blocking: blockingKey, blocked: blockedKey }),
      });
    }

    return hydrateIssue(tx, blocked.id, context);
  });
}
