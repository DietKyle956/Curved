import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";
import { normalizeLabels } from "../domain/validation.ts";
import { hydrateIssue } from "./issue-read-model.ts";
import type { Ports } from "./ports.ts";

export interface SetIssueLabelsInput {
  key: string;
  labels: readonly string[];
  actor?: string;
  agent?: string;
}

/**
 * Replaces an issue's label set. Labels are scoped to the issue's project and
 * created on first use. The whole replacement is one `labels` event so the
 * timeline records who changed the set, not each row.
 */
export async function setIssueLabels(
  ports: Ports,
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

  return ports.transaction(async (tx) => {
    const issue = await tx.issues.findByKey(key);
    if (issue === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }

    await tx.labels.replace({
      issueId: issue.id,
      projectId: issue.projectId,
      names,
    });

    await tx.events.append({
      issueId: issue.id,
      kind: "labels",
      actorType: "human",
      body: JSON.stringify({ labels: names }),
    });

    return hydrateIssue(tx, issue.id, { actor: "human", agent: null });
  });
}
