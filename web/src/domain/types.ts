import type {
  ActorType,
  EventKind,
  Priority,
  ProjectStatus,
  Status,
} from "../../../src/domain/status.ts";

export type { ActorType, EventKind, Priority, ProjectStatus, Status };

export interface Actor {
  type: ActorType;
  name: string | null;
}

export interface Project {
  id: number;
  key: string;
  name: string;
  summary: string;
  description: string;
  status: ProjectStatus;
  priority: Priority | null;
  startDate: string | null;
  targetDate: string | null;
  archivedAt: string | null;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
  progress: ProjectProgress;
}

export interface ProjectProgress {
  total: number;
  done: number;
  byStatus: Record<Status, number>;
}

export interface NewProjectInput {
  key: string;
  name: string;
  summary?: string;
  description?: string;
  status?: ProjectStatus;
  priority?: Priority | null;
  startDate?: string | null;
  targetDate?: string | null;
}

export interface ProjectPatch {
  name?: string;
  summary?: string;
  description?: string;
  status?: ProjectStatus;
  priority?: Priority | null;
  startDate?: string | null;
  targetDate?: string | null;
  archived?: boolean;
}

export interface Issue {
  id: number;
  key: string;
  projectId: number;
  projectKey: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  allowedTransitions: Status[];
  priority: Priority;
  parentId: number | null;
  parentKey: string | null;
  blockedReason: string | null;
  claimedBy: string | null;
  labels: string[];
  relations: { blocks: string[]; blockedBy: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface IssueRef {
  key: string;
  title: string;
  status: Status;
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

export interface IssueTimeline {
  issue: Issue;
  events: IssueEvent[];
  children: IssueRef[];
}

export interface ReadyQueue {
  ready: Issue[];
  busy: string | null;
}

export interface ProjectList {
  projects: Project[];
}

export interface PasskeySummary {
  id: string;
  nickname: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  rpId: string | null;
  usable: boolean;
}

export interface NewIssueInput {
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  labels: string[];
  blocks: string[];
  blockedBy: string[];
  parent?: string;
}

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
