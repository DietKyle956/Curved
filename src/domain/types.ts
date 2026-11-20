import type { ActorType, EventKind, Priority, Status } from "./status.ts";

export interface Issue {
  id: number;
  key: string;
  projectId: number;
  projectKey: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  /** Transitions the reading actor may take from `status` right now. */
  allowedTransitions: Status[];
  priority: Priority;
  parentId: number | null;
  blockedReason: string | null;
  claimedBy: string | null;
  /** Label names in ascending order. */
  labels: string[];
  /** Issue keys in ascending order; `blocks` points out, `blockedBy` points in. */
  relations: { blocks: string[]; blockedBy: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: number;
  key: string;
  name: string;
  nextNumber: number;
  createdAt: string;
}

export interface Agent {
  id: number;
  name: string;
  createdAt: string;
}

export interface CreatedAgent {
  agent: Agent;
  token: string;
}

export interface PasskeySummary {
  id: string;
  nickname: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface IssueEvent {
  id: number;
  issueId: number;
  kind: EventKind;
  actorType: ActorType;
  fromStatus: Status | null;
  toStatus: Status | null;
  body: string | null;
  createdAt: string;
}

export interface IssueRelations {
  blocks: string[];
  blockedBy: string[];
}

export interface IssueMeta {
  labels: string[];
  relations: IssueRelations;
}

/** Fresh arrays every call, so callers may fill them without aliasing. */
export function emptyMeta(): IssueMeta {
  return { labels: [], relations: { blocks: [], blockedBy: [] } };
}
