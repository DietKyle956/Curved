import type { QueryResultRow } from "pg";
import type { Db } from "../pool.ts";
import type { RelationRepository } from "../../../application/ports.ts";

interface InsertedRelationRow extends QueryResultRow {
  blocking_issue_id: number;
}

export function createRelationRepository(db: Db): RelationRepository {
  return {
    async add(input: {
      blockingIssueId: number;
      blockedIssueId: number;
    }): Promise<boolean> {
      const row = await db.one<InsertedRelationRow>(
        `insert into issue_relations (blocking_issue_id, blocked_issue_id)
         values ($1, $2)
         on conflict (blocking_issue_id, blocked_issue_id) do nothing
         returning blocking_issue_id`,
        [input.blockingIssueId, input.blockedIssueId],
      );
      return row !== null;
    },
  };
}
