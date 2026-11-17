import type { Database } from "../db.ts";
import { bindPorts } from "../adapters/postgres/ports.ts";
import { getIssue } from "../application/issues.ts";
import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import type { IssueEvent } from "../domain/types.ts";
import { validateCommentBody } from "../domain/validation.ts";
import { ensureAgentExists } from "./agents.ts";

export interface CommentInput {
  key: string;
  body: string;
  actor?: string;
  agent?: string;
}

export async function commentOnIssue(
  db: Database,
  input: CommentInput,
): Promise<IssueEvent> {
  const body = validateCommentBody(input.body);
  const { actor, agent } = resolveContext({
    actor: input.actor,
    agent: input.agent,
  });
  let agentName: string | null = null;
  if (actor === "agent") {
    if (agent === null) {
      throw new ServiceError(
        "validation",
        'actor "agent" requires an agent identity',
      );
    }
    agentName = agent;
    await ensureAgentExists(db, agent);
  }
  const issue = await getIssue(bindPorts(db), input.key, {
    actor,
    agent: agentName ?? undefined,
  });
  if (
    agentName !== null &&
    issue.claimedBy !== null &&
    issue.claimedBy !== agentName
  ) {
    throw new ServiceError(
      "forbidden_transition",
      `agent "${agentName}" may not comment on issue "${issue.key}" claimed by "${issue.claimedBy}"`,
    );
  }

  return db.tx(async (tx) =>
    bindPorts(tx).events.append({
      issueId: issue.id,
      kind: "comment",
      actorType: actor,
      fromStatus: null,
      toStatus: null,
      body,
    }),
  );
}
