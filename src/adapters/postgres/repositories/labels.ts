import type { QueryResultRow } from "pg";
import type { Db } from "../pool.ts";
import type { LabelRepository } from "../../../application/ports.ts";

interface LabelIdRow extends QueryResultRow {
  id: number;
}

export function createLabelRepository(db: Db): LabelRepository {
  return {
    async replace(input: {
      issueId: number;
      projectId: number;
      names: readonly string[];
    }): Promise<void> {
      const labelIds = await db.query<LabelIdRow>(
        `insert into labels (project_id, name)
         select $1, name from unnest($2::text[]) as name
         on conflict (project_id, name) do update set name = excluded.name
         returning id`,
        [input.projectId, input.names],
      );

      await db.query(`delete from issue_labels where issue_id = $1`, [
        input.issueId,
      ]);
      await db.query(
        `insert into issue_labels (issue_id, label_id)
         select $1, id from unnest($2::int[]) as id`,
        [input.issueId, labelIds.map((row) => row.id)],
      );
    },
  };
}
