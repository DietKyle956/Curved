import type { QueryResultRow } from "pg";
import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { appendEvent } from "./events.ts";
import { hydrateIssue, parseIssueKey, resolveContext } from "./issues.ts";
import type { Issue } from "./issues.ts";

export const LABEL_NAME_MAX_LENGTH = 50;

export interface SetIssueLabelsInput {
  key: string;
  labels: readonly string[];
  actor?: string;
  agent?: string;
}

interface IssueProjectRow extends QueryResultRow {
  id: number;
  project_id: number;
}

/**
 * Normalizes a label set: every name must be a string, trims to a non-empty
 * name of at most `LABEL_NAME_MAX_LENGTH` characters, and duplicates collapse.
 * The result is sorted so the event body is deterministic.
 */
function normalizeLabels(raw: readonly string[]): string[] {
  if (!Array.isArray(raw)) {
    throw new ServiceError("validation", "labels must be an array of strings");
  }
  const names = new Set<string>();
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string") {
      throw new ServiceError(
        "validation",
        `label at index ${index} must be a string`,
      );
    }
    const name = value.trim();
    if (name.length === 0) {
      throw new ServiceError("validation", `label at index ${index} is empty`);
    }
    if (name.length > LABEL_NAME_MAX_LENGTH) {
      throw new ServiceError(
        "validation",
        `label must be at most ${LABEL_NAME_MAX_LENGTH} characters, got ${name.length}`,
      );
    }
    names.add(name);
  }
  return [...names].sort();
}

/**
 * Replaces an issue's label set. Labels are scoped to the issue's project and
 * created on first use. The whole replacement is one `labels` event so the
 * timeline records who changed the set, not each row.
 */
export async function setIssueLabels(
  db: Database,
  input: SetIssueLabelsInput,
): Promise<Issue> {
  const context = resolveContext({ actor: input.actor, agent: input.agent });
  const key = parseIssueKey(input.key).key;
  if (context.actor !== "human") {
    throw new ServiceError(
      "forbidden_transition",
      `actor "${context.actor}" may not set labels on issue "${key}"`,
    );
  }
  const names = normalizeLabels(input.labels);

  return db.tx(async (tx) => {
    const issue = await tx.one<IssueProjectRow>(
      `select id, project_id from issues where key = $1`,
      [key],
    );
    if (issue === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }

    const labelIds = await tx.query<{ id: number }>(
      `insert into labels (project_id, name)
       select $1, name from unnest($2::text[]) as name
       on conflict (project_id, name) do update set name = excluded.name
       returning id`,
      [issue.project_id, names],
    );

    await tx.query(`delete from issue_labels where issue_id = $1`, [issue.id]);
    await tx.query(
      `insert into issue_labels (issue_id, label_id)
       select $1, id from unnest($2::int[]) as id`,
      [issue.id, labelIds.map((row) => row.id)],
    );

    await appendEvent(tx, {
      issueId: issue.id,
      kind: "labels",
      actorType: "human",
      body: JSON.stringify({ labels: names }),
    });

    return hydrateIssue(tx, issue.id, { actor: "human", agent: null });
  });
}
