import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import type { IssueEvent } from "../domain/types.ts";
import { validateCommentBody } from "../domain/validation.ts";
import { ensureAgentExists } from "./agents.ts";
import { getIssue } from "./issues.ts";
import type { Ports } from "./ports.ts";

export interface CommentInput {
  key: string;
  body: string;
  actor?: string;
  agent?: string;
}

export async function commentOnIssue(
  ports: Ports,
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
    await ensureAgentExists(ports, agent);
  }
  const issue = await getIssue(ports, input.key, {
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

  return ports.transaction((tx) =>
    tx.events.append({
      issueId: issue.id,
      kind: "comment",
      actorType: actor,
      fromStatus: null,
      toStatus: null,
      body,
    }),
  );
}
