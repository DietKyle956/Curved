import type { QueryResultRow } from "pg";
import { bindPorts } from "../adapters/postgres/ports.ts";
import { hydrateIssue } from "../application/issue-read-model.ts";
import type { Database } from "../db.ts";
import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";

export interface AddRelationInput {
  blocked: string;
  blocking: string;
  actor?: string;
  agent?: string;
}

interface IssueIdRow extends QueryResultRow {
  id: number;
  key: string;
}

interface InsertedRelationRow extends QueryResultRow {
  blocking_issue_id: number;
}

/**
 * Records that one issue blocks another. Only a human may add a relation.
 * The edge is idempotent: a duplicate add writes no second event.
 */
export async function addRelation(
  db: Database,
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

  const rows = await db.query<IssueIdRow>(
    `select id, key from issues where key = any($1::text[])`,
    [[blockedKey, blockingKey]],
  );
  const blocked = rows.find((row) => row.key === blockedKey);
  if (blocked === undefined) {
    throw new ServiceError("not_found", `issue "${blockedKey}" not found`);
  }
  const blocking = rows.find((row) => row.key === blockingKey);
  if (blocking === undefined) {
    throw new ServiceError("not_found", `issue "${blockingKey}" not found`);
  }

  return db.tx(async (tx) => {
    const ports = bindPorts(tx);

    const inserted = await tx.one<InsertedRelationRow>(
      `insert into issue_relations (blocking_issue_id, blocked_issue_id)
       values ($1, $2)
       on conflict (blocking_issue_id, blocked_issue_id) do nothing
       returning blocking_issue_id`,
      [blocking.id, blocked.id],
    );
    if (inserted !== null) {
      await ports.events.append({
        issueId: blocked.id,
        kind: "relation",
        actorType: "human",
        fromStatus: null,
        toStatus: null,
        body: JSON.stringify({ blocking: blockingKey, blocked: blockedKey }),
      });
    }

    return hydrateIssue(ports, blocked.id, context);
  });
}
