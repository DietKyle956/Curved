import type { Database } from "../db.ts";
import { bindPorts } from "../adapters/postgres/ports.ts";
import { hydrateIssue } from "../application/issue-read-model.ts";
import { resolveContext } from "../domain/actors.ts";
import { ServiceError } from "../domain/errors.ts";
import { parseIssueKey } from "../domain/keys.ts";
import type { Issue } from "../domain/types.ts";
import { validateBlockReason } from "../domain/validation.ts";
import { ensureAgentExists } from "./agents.ts";

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

/**
 * Blocks an agent's claimed issue: the claim is released, the issue returns to
 * the backlog, and the reason is recorded on the row. Ownership is checked
 * here explicitly because this is not a generic status move.
 */
export async function blockIssue(
  db: Database,
  input: BlockIssueInput,
): Promise<Issue> {
  const reason = validateBlockReason(input.reason);
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
    const ports = bindPorts(tx);
    const locked = await ports.issues.lockByKey(key);
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.claimedBy !== agent) {
      throw new ServiceError(
        "forbidden_transition",
        `agent "${agent}" may not block issue "${key}" claimed by "${locked.claimedBy}"`,
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
    await ports.events.append({
      issueId: locked.id,
      kind: "blocked",
      actorType: "agent",
      fromStatus: "in_progress",
      toStatus: "todo",
      body: reason,
    });

    return hydrateIssue(ports, locked.id, { actor: "agent", agent });
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
    const ports = bindPorts(tx);
    const locked = await ports.issues.lockByKey(key);
    if (locked === null) {
      throw new ServiceError("not_found", `issue "${key}" not found`);
    }
    if (locked.blockedReason === null) {
      throw new ServiceError("validation", `issue "${key}" is not blocked`);
    }

    await tx.query(
      `update issues set blocked_reason = null, updated_at = now() where id = $1`,
      [locked.id],
    );
    await ports.events.append({
      issueId: locked.id,
      kind: "unblocked",
      actorType: "human",
      fromStatus: null,
      toStatus: null,
      body: null,
    });

    return hydrateIssue(ports, locked.id, context);
  });
}
