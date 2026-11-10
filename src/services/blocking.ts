import type { QueryResultRow } from "pg";
import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import type { Status } from "../shared/status.ts";
import { appendEvent } from "./events.ts";
import { ensureAgentExists } from "./agents.ts";
import { hydrateIssue, parseIssueKey, resolveContext } from "./issues.ts";
import type { Issue } from "./issues.ts";

export const BLOCKED_REASON_MAX_LENGTH = 2000;

export interface BlockIssueInput {
  key: string;
  agent: string;
  reason: string;
}

export interface UnblockIssueInput {
  key: string;
  actor?: string;
  agent?: string;
}

interface LockedIssueRow extends QueryResultRow {
  id: number;
  status: Status;
  claimed_by: string | null;
}

interface LockedBlockedIssueRow extends QueryResultRow {
  id: number;
  status: Status;
  blocked_reason: string | null;
}

/**
 * Blocks an agent's claimed issue: the claim is released, the issue returns to
 * the backlog, and the reason is recorded on the row. Ownership is checked
 * here explicitly because this is not a generic status move.
 */
export async function blockIssue(
  db: Database,
  input: BlockIssueInput,
): Promise<Issue> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new ServiceError("validation", "blocked reason must not be empty");
  }
  if (reason.length > BLOCKED_REASON_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `blocked reason must be at most ${BLOCKED_REASON_MAX_LENGTH} characters, got ${reason.length}`,
    );
  }
  const agent = input.agent.trim();
  if (agent.length === 0) {
    throw new ServiceError(
      "validation",
      'actor "agent" requires an agent identity',
    );
  }
  await ensureAgentExists(db, agent);
  const key = parseIssueKey(input.key).key;

  return db.tx(async (tx) => {
    const locked = await tx.one<LockedIssueRow>(
      `select id, status, claimed_by from issues where key = $1 for update`,
      [key],
    );
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.claimed_by !== agent) {
      throw new ServiceError(
        "forbidden_transition",
        `agent "${agent}" may not block issue "${key}" claimed by "${locked.claimed_by}"`,
      );
    }
    if (locked.status !== "in_progress") {
      throw new ServiceError(
        "illegal_transition",
        `issue "${key}" cannot be blocked from "${locked.status}"`,
      );
    }

    await tx.query(
      `update issues
       set status = 'todo', claimed_by = null, blocked_reason = $2, updated_at = now()
       where id = $1`,
      [locked.id, reason],
    );
    await appendEvent(tx, {
      issueId: locked.id,
      kind: "blocked",
      actorType: "agent",
      fromStatus: "in_progress",
      toStatus: "todo",
      body: reason,
    });

    return hydrateIssue(tx, locked.id, { actor: "agent", agent });
  });
}

/**
 * Clears a block. Only a human may do this, and the issue must actually be
 * blocked; status and claim are left untouched.
 */
export async function unblockIssue(
  db: Database,
  input: UnblockIssueInput,
): Promise<Issue> {
  const key = parseIssueKey(input.key).key;
  const context = resolveContext({ actor: input.actor, agent: input.agent });
  if (context.actor !== "human") {
    throw new ServiceError(
      "forbidden_transition",
      `actor "${context.actor}" may not unblock issue "${key}"`,
    );
  }

  return db.tx(async (tx) => {
    const locked = await tx.one<LockedBlockedIssueRow>(
      `select id, status, blocked_reason from issues where key = $1 for update`,
      [key],
    );
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.blocked_reason === null) {
      throw new ServiceError("validation", `issue "${key}" is not blocked`);
    }

    await tx.query(
      `update issues set blocked_reason = null, updated_at = now() where id = $1`,
      [locked.id],
    );
    await appendEvent(tx, {
      issueId: locked.id,
      kind: "unblocked",
      actorType: "human",
      fromStatus: null,
      toStatus: null,
      body: null,
    });

    return hydrateIssue(tx, locked.id, context);
  });
}
