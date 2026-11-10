import type { QueryResultRow } from "pg";
import type { Db } from "../db.ts";

export interface IssueRelations {
  blocks: string[];
  blockedBy: string[];
}

export interface IssueMeta {
  labels: string[];
  relations: IssueRelations;
}

/** Fresh arrays every call, so callers may fill them without aliasing. */
export function emptyMeta(): IssueMeta {
  return { labels: [], relations: { blocks: [], blockedBy: [] } };
}

interface LabelRow extends QueryResultRow {
  issue_id: number;
  name: string;
}

interface RelationRow extends QueryResultRow {
  blocking_issue_id: number;
  blocking_key: string;
  blocked_issue_id: number;
  blocked_key: string;
}

/**
 * Loads labels and relations for a batch of issues in at most two statements.
 * Every requested id appears in the map; unknown ids are not queried at all.
 */
export async function loadIssueMeta(
  db: Db,
  issueIds: readonly number[],
): Promise<Map<number, IssueMeta>> {
  const meta = new Map<number, IssueMeta>();
  if (issueIds.length === 0) {
    return meta;
  }
  for (const id of issueIds) {
    meta.set(id, emptyMeta());
  }

  const labels = await db.query<LabelRow>(
    `select il.issue_id, l.name
     from issue_labels il
     join labels l on l.id = il.label_id
     where il.issue_id = any($1::int[])
     order by l.name asc`,
    [issueIds],
  );
  for (const row of labels) {
    meta.get(row.issue_id)?.labels.push(row.name);
  }

  const relations = await db.query<RelationRow>(
    `select r.blocking_issue_id,
            blocker.key as blocking_key,
            r.blocked_issue_id,
            blocked.key as blocked_key
     from issue_relations r
     join issues blocker on blocker.id = r.blocking_issue_id
     join issues blocked on blocked.id = r.blocked_issue_id
     where r.blocking_issue_id = any($1::int[])
        or r.blocked_issue_id = any($1::int[])`,
    [issueIds],
  );
  for (const row of relations) {
    const blocking = meta.get(row.blocking_issue_id);
    if (blocking !== undefined) {
      blocking.relations.blocks.push(row.blocked_key);
    }
    const blocked = meta.get(row.blocked_issue_id);
    if (blocked !== undefined) {
      blocked.relations.blockedBy.push(row.blocking_key);
    }
  }

  for (const entry of meta.values()) {
    entry.relations.blocks.sort();
    entry.relations.blockedBy.sort();
  }
  return meta;
}
