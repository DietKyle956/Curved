// Single contract for statuses, priorities, event kinds, and actor types.
// Every layer (database constraints, services, CLI) imports these values so
// stored strings and compile-time types can never drift apart.

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = [1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EVENT_KINDS = [
  "created",
  "status",
  "comment",
  "claim",
  "release",
  "blocked",
  "unblocked",
  "labels",
  "relation",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ACTOR_TYPES = ["agent", "human", "git", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const DEFAULT_STATUS: Status = "backlog";
export const DEFAULT_PRIORITY: Priority = 3;

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: number): value is Priority {
  return (PRIORITIES as readonly number[]).includes(value);
}

export function isActorType(value: string): value is ActorType {
  return (ACTOR_TYPES as readonly string[]).includes(value);
}

/**
 * Legal status edges. This is the whole graph; no adapter may add an edge.
 */
export const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  backlog: ["todo"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo", "in_review"],
  in_review: ["done", "in_progress"],
  done: ["todo"],
};

type StatusEdge = readonly [Status, Status];

const ALL_EDGES: readonly StatusEdge[] = STATUSES.flatMap((from) =>
  TRANSITIONS[from].map((to) => [from, to] as const),
);

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
  human: ALL_EDGES,
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

export function isLegalTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

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
