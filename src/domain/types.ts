import type {
  ActorType,
  EventKind,
  Priority,
  ProjectStatus,
  Status,
} from "./status.ts";

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
  summary: string;
  description: string;
  status: ProjectStatus;
  priority: Priority | null;
  startDate: string | null; // YYYY-MM-DD
  targetDate: string | null; // YYYY-MM-DD
  archivedAt: string | null;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectProgress {
  total: number;
  done: number;
  byStatus: Record<Status, number>;
}

export interface ProjectWithProgress extends Project {
  progress: ProjectProgress;
}

export function emptyProgress(): ProjectProgress {
  return {
    total: 0,
    done: 0,
    byStatus: { backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0 },
  };
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
  /** RP ID that registered this credential; null for legacy rows. */
  rpId: string | null;
  /** True when the credential can be used for sign-in on the current domain. */
  usable: boolean;
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
