import type { QueryResultRow } from "pg";
import { bindPorts } from "../adapters/postgres/ports.ts";
import { hydrateIssue } from "../application/issue-read-model.ts";
import type { Database } from "../db.ts";
import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";
import { normalizeLabels } from "../domain/validation.ts";

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

    const ports = bindPorts(tx);

    await ports.events.append({
      issueId: issue.id,
      kind: "labels",
      actorType: "human",
      body: JSON.stringify({ labels: names }),
    });

    return hydrateIssue(ports, issue.id, { actor: "human", agent: null });
  });
}
