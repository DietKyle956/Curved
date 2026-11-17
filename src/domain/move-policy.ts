import { actorMayTransition } from "./actors.ts";
import type { ActorType, Status } from "./status.ts";

/**
 * Whether a legal edge may be taken by this actor with this ownership.
 * The legal-edge gate runs first; this gate is strictly about authority.
 */
export function mayMove(
  actor: ActorType,
  agent: string | null,
  from: Status,
  to: Status,
  claimedBy: string | null,
): boolean {
  if (actor === "human") {
    return true;
  }
  if (actor === "agent") {
    if (from === "todo" && to === "in_progress" && claimedBy === null) {
      return agent !== null;
    }
    return (
      agent !== null &&
      claimedBy !== null &&
      claimedBy === agent &&
      actorMayTransition("agent", from, to)
    );
  }
  if (actor === "system") {
    return false;
  }
  return actorMayTransition(actor, from, to);
}
