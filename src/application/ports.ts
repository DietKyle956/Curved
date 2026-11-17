import type { ActorType, EventKind, Priority, Status } from "../domain/status.ts";
import type { IssueEvent, IssueMeta, Project } from "../domain/types.ts";

/**
 * The application boundary. Use cases depend only on these interfaces, so no
 * PostgreSQL types, SQL text, or driver knowledge leak into the application
 * layer. Adapters implement them.
 */
export interface ProjectRepository {
  create(input: { key: string; name: string }): Promise<Project>;
  list(): Promise<Project[]>;
  findByKey(key: string): Promise<Project | null>;
}

/** A stored issue row projected by the issue repository. */
export interface IssueRecord {
  id: number;
  projectId: number;
  projectKey: string;
  number: number;
  key: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  parentId: number | null;
  blockedReason: string | null;
  claimedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The claim-relevant projection of a row locked for update. */
export interface LockedIssueRecord {
  id: number;
  status: Status;
  claimedBy: string | null;
  blockedReason: string | null;
}

export interface IssueRepository {
  /** Allocates the next per-project number and inserts; null when the project key is unknown. */
  create(input: {
    projectKey: string;
    title: string;
    description: string;
    status: Status;
    priority: Priority;
    parentId: number | null;
  }): Promise<IssueRecord | null>;
  findById(id: number): Promise<IssueRecord | null>;
  findByKey(key: string): Promise<IssueRecord | null>;
  lockByKey(key: string): Promise<LockedIssueRecord | null>;
  list(filter: { project: string | null; status: Status | null }): Promise<IssueRecord[]>;
  updateFields(input: {
    key: string;
    title: string | null;
    description: string | null;
    priority: Priority | null;
  }): Promise<{ id: number } | null>;
  /** Sets status and claim column; a one-active-claim fence violation becomes ActiveClaimConflict. */
  updateStatus(input: { id: number; status: Status; claimedBy: string | null }): Promise<void>;
  findActiveClaimKey(agent: string): Promise<string | null>;
  /** Ready rows: todo, unblocked, no not-done blocker, priority/number/key order. */
  listReady(filter: { project: string | null }): Promise<IssueRecord[]>;
}

export interface IssueEventRepository {
  append(input: {
    issueId: number;
    kind: EventKind;
    actorType: ActorType;
    fromStatus?: Status | null;
    toStatus?: Status | null;
    body?: string | null;
  }): Promise<IssueEvent>;
  list(issueId: number): Promise<IssueEvent[]>;
}

export interface IssueMetaRepository {
  /** At most two statements; every requested id is present; unknown ids are never queried. */
  loadForIds(issueIds: readonly number[]): Promise<Map<number, IssueMeta>>;
}

export interface AgentRepository {
  exists(name: string): Promise<boolean>;
}

/** Mints a fresh agent token and hashes a presented one for lookup. */
export interface TokenCodec {
  mint(): string;
  hash(token: string): string;
}

/**
 * Port-level error: the adapter throws it when a write violates the
 * `issues_one_active_claim_per_agent` constraint. A use case maps it to the
 * `agent_busy` service error.
 */
export class ActiveClaimConflict extends Error {
  constructor(message = "agent already holds an active claim") {
    super(message);
    this.name = "ActiveClaimConflict";
  }
}

/** Ports bound to a single database transaction. */
export interface TransactionPorts {
  projects: ProjectRepository;
  issues: IssueRepository;
  events: IssueEventRepository;
  meta: IssueMetaRepository;
  agents: AgentRepository;
  tokens: TokenCodec;
}

/**
 * Ports as seen by the outside world. `transaction` runs the callback inside
 * exactly one flat transaction, handing it ports bound to that transaction.
 */
export interface Ports extends TransactionPorts {
  transaction<T>(fn: (ports: TransactionPorts) => Promise<T>): Promise<T>;
}
