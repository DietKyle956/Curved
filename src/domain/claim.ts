// Claim policy: leaving for `todo` or `backlog` clears the claim, an agent
// claiming into `in_progress` takes it, and every other target keeps it. The
// partial unique index `issues_one_active_claim_per_agent` is the storage
// enforcement of the one-active-issue fence, not the policy source.

import type { ActorType, Status } from "./status.ts";

/**
 * The claim column after a move: leaving for the backlog clears it, an agent
 * claiming into `in_progress` takes it, and every other target keeps it.
 */
export function nextClaimedBy(
  actor: ActorType,
  agent: string | null,
  to: Status,
  current: string | null,
): string | null {
  if (to === "todo" || to === "backlog") {
    return null;
  }
  if (to === "in_progress" && actor === "agent") {
    return agent;
  }
  return current;
}
