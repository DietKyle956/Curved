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
