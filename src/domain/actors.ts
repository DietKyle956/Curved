import { ServiceError } from "./errors.ts";
import { isActorType } from "./status.ts";
import type { ActorType, Status } from "./status.ts";
import { LEGAL_EDGES, TRANSITIONS } from "./transition.ts";
import type { StatusEdge } from "./transition.ts";

/**
 * Actor matrix: which legal edges each actor type may take. Ownership is a
 * separate precondition for agents (see `allowedTransitions`).
 *
 * `todo -> in_progress` is the agent claim edge: it is available only to a
 * named agent on an unclaimed issue, so the service sets `claimed_by` when it
 * is used. Every other agent edge requires ownership of the claim.
 */
export const ACTOR_TRANSITIONS: Readonly<
  Record<ActorType, readonly StatusEdge[]>
> = {
  human: LEGAL_EDGES,
  agent: [
    ["todo", "in_progress"],
    ["in_progress", "in_review"],
    ["in_progress", "todo"],
  ],
  git: [
    ["in_progress", "in_review"],
    ["in_review", "done"],
  ],
  system: [],
};

export function actorMayTransition(
  actor: ActorType,
  from: Status,
  to: Status,
): boolean {
  return ACTOR_TRANSITIONS[actor].some(
    ([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to,
  );
}

export interface TransitionContext {
  actor: ActorType;
  agent?: string | null;
  claimedBy?: string | null;
}

/**
 * The legal successors of `from` that this actor may actually take now.
 * Agents see the claim edge only while the issue is unclaimed, and every other
 * agent edge only once the issue is claimed by that same agent.
 */
export function allowedTransitions(
  from: Status,
  context: TransitionContext,
): Status[] {
  const agent = context.agent ?? null;
  const claimedBy = context.claimedBy ?? null;
  const agentOwns = agent !== null && claimedBy !== null && claimedBy === agent;

  return TRANSITIONS[from].filter((to) => {
    if (context.actor === "agent") {
      if (from === "todo" && to === "in_progress") {
        return agent !== null && claimedBy === null;
      }
      return agentOwns && actorMayTransition("agent", from, to);
    }
    return actorMayTransition(context.actor, from, to);
  });
}

/**
 * Who is reading an issue. `actor` defaults to `human`; `agent` names the
 * agent identity and is only valid alongside `actor: "agent"`.
 */
export interface IssueContext {
  actor?: string;
  agent?: string;
}

export interface ResolvedContext {
  actor: ActorType;
  agent: string | null;
}

export function resolveContext(context?: IssueContext): ResolvedContext {
  const actor = validateActor(context?.actor ?? "human");
  if (context?.agent === undefined) {
    return { actor, agent: null };
  }
  const agent = context.agent.trim();
  if (agent.length === 0) {
    throw new ServiceError("validation", "agent identity must not be empty");
  }
  if (actor !== "agent") {
    throw new ServiceError(
      "validation",
      `agent identity "${agent}" requires actor "agent", got "${actor}"`,
    );
  }
  return { actor, agent };
}

export function validateActor(raw: string): ActorType {
  if (!isActorType(raw)) {
    throw new ServiceError(
      "validation",
      `actor type "${raw}" must be one of: agent, human, git, system`,
    );
  }
  return raw;
}
