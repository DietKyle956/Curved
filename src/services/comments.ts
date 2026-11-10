import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { appendEvent } from "./events.ts";
import type { IssueEvent } from "./events.ts";
import { ensureAgentExists } from "./agents.ts";
import { getIssue, resolveContext } from "./issues.ts";

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
  const body = input.body.trim();
  if (body.length === 0) {
    throw new ServiceError("validation", "comment body must not be empty");
  }
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
  const issue = await getIssue(db, input.key, {
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
    appendEvent(tx, {
      issueId: issue.id,
      kind: "comment",
      actorType: actor,
      fromStatus: null,
      toStatus: null,
      body,
    }),
  );
}
