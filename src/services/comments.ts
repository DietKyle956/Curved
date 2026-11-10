import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { appendEvent } from "./events.ts";
import type { IssueEvent } from "./events.ts";
import { getIssue, validateActor } from "./issues.ts";

export interface CommentInput {
  key: string;
  body: string;
  actor?: string;
}

export async function commentOnIssue(
  db: Database,
  input: CommentInput,
): Promise<IssueEvent> {
  const body = input.body.trim();
  if (body.length === 0) {
    throw new ServiceError("validation", "comment body must not be empty");
  }
  const actor = validateActor(input.actor ?? "human");
  const issue = await getIssue(db, input.key);

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
