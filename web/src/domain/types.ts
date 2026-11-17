import type {
  ActorType,
  EventKind,
  Priority,
  Status,
} from "../../../src/domain/status.ts";

export type { ActorType, EventKind, Priority, Status };

export interface Actor {
  type: ActorType;
  name: string | null;
}

export interface Project {
  id: number;
  key: string;
  name: string;
  nextNumber: number;
  createdAt: string;
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
  blockedReason: string | null;
  claimedBy: string | null;
  labels: string[];
  relations: { blocks: string[]; blockedBy: string[] };
  createdAt: string;
  updatedAt: string;
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
}

export interface ReadyQueue {
  ready: Issue[];
  busy: string | null;
}

export interface ProjectList {
  projects: Project[];
}

export interface NewIssueInput {
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  labels: string[];
}

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
