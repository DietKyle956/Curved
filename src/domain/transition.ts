import { STATUSES } from "./status.ts";
import type { Status } from "./status.ts";

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

export type StatusEdge = readonly [Status, Status];

/**
 * Every legal edge, used to build the actor matrix.
 */
export const LEGAL_EDGES: readonly StatusEdge[] = STATUSES.flatMap((from) =>
  TRANSITIONS[from].map((to) => [from, to] as const),
);

export function isLegalTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}
