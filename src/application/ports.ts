import type {
  ActorType,
  EventKind,
  Priority,
  ProjectStatus,
  Status,
} from "../domain/status.ts";
import type {
  Agent,
  IssueEvent,
  IssueMeta,
  PasskeySummary,
  Project,
  ProjectWithProgress,
} from "../domain/types.ts";

/**
 * The application boundary. Use cases depend only on these interfaces, so no
 * PostgreSQL types, SQL text, or driver knowledge leak into the application
 * layer. Adapters implement them.
 */
export interface CreateProjectRecordInput {
  key: string;
  name: string;
  summary: string;
  description: string;
  status: ProjectStatus;
  priority: Priority | null;
  startDate: string | null;
  targetDate: string | null;
}

export interface UpdateProjectRecordInput {
  key: string;
  name?: string;
  summary?: string;
  description?: string;
  status?: ProjectStatus;
  priority?: Priority | null;
  startDate?: string | null;
  targetDate?: string | null;
  archived?: boolean;
}

export interface ProjectRepository {
  create(input: CreateProjectRecordInput): Promise<ProjectWithProgress>;
  list(input: { includeArchived: boolean }): Promise<ProjectWithProgress[]>;
  findByKey(key: string): Promise<Project | null>;
  findWithProgressByKey(key: string): Promise<ProjectWithProgress | null>;
  update(input: UpdateProjectRecordInput): Promise<ProjectWithProgress | null>;
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
  /** Sets status todo, clears the claim, and records the blocked reason in one statement. */
  block(input: { id: number; reason: string }): Promise<void>;
  /** Clears the blocked reason in one statement, leaving status and claim untouched. */
  unblock(input: { id: number }): Promise<void>;
  /**
   * Locks the next claim candidate and skips rows locked elsewhere: todo,
   * unblocked, no not-done blocker, priority then number then key order.
   */
  lockClaimCandidate(filter: { project: string | null }): Promise<{ id: number } | null>;
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
  /** Inserts an agent; a duplicate name becomes a `duplicate` service error. */
  create(input: { name: string; tokenHash: string }): Promise<Agent>;
  findByTokenHash(tokenHash: string): Promise<Agent | null>;
  findByName(name: string): Promise<Agent | null>;
  /** Serializes concurrent claims by one agent inside the current transaction. */
  acquireClaimLock(name: string): Promise<void>;
}

export interface LabelRepository {
  /** Upserts the project's labels by name and replaces the issue's label set; no return value. */
  replace(input: { issueId: number; projectId: number; names: readonly string[] }): Promise<void>;
}

export interface RelationRepository {
  /** Inserts the edge idempotently; true when a row was created. */
  add(input: { blockingIssueId: number; blockedIssueId: number }): Promise<boolean>;
}

/** Mints a fresh agent token and hashes a presented one for lookup. */
export interface TokenCodec {
  mint(): string;
  hash(token: string): string;
  /** Unprefixed opaque base64url nonce for cookies and challenge ids. */
  mintNonce(): string;
}

/** How a browser session was established. */
export type SessionMethod = "token" | "passkey";

/** A stored browser session; only the token hash is persisted. */
export interface AuthSessionRecord {
  tokenHash: string;
  method: SessionMethod;
  credentialId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuthSessionRepository {
  create(input: {
    tokenHash: string;
    method: SessionMethod;
    credentialId: string | null;
    expiresAt: Date;
  }): Promise<AuthSessionRecord>;
  /** Never returns expired rows. */
  findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  deleteExpired(now: Date): Promise<void>;
}

/** The ceremony a stored WebAuthn challenge belongs to. */
export type WebAuthnChallengeKind = "registration" | "authentication";

export interface WebAuthnChallengeRepository {
  create(input: {
    id: string;
    challenge: string;
    kind: WebAuthnChallengeKind;
    expiresAt: Date;
  }): Promise<void>;
  /** Atomic delete-and-return: null when the row is unknown, of another kind, or expired. */
  consume(input: { id: string; kind: WebAuthnChallengeKind; now: Date }): Promise<string | null>;
  deleteExpired(now: Date): Promise<void>;
}

/** A stored WebAuthn credential: summary fields plus the verification material. */
export interface PasskeyRecord
  extends Omit<PasskeySummary, "createdAt" | "lastUsedAt" | "usable"> {
  /** RP ID that registered this credential; null for legacy rows. */
  rpId: string | null;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface PasskeyRepository {
  /** Inserts a credential; a duplicate id becomes a `duplicate` service error. */
  create(input: {
    id: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    nickname: string;
    rpId: string;
  }): Promise<PasskeyRecord>;
  /** Every stored credential, including legacy and other-domain rows. */
  list(): Promise<PasskeyRecord[]>;
  /** Count of every stored credential, including legacy and other-domain rows. */
  count(): Promise<number>;
  /** Only credentials registered for the given RP ID. */
  listForRpId(rpId: string): Promise<PasskeyRecord[]>;
  countForRpId(rpId: string): Promise<number>;
  findById(id: string): Promise<PasskeyRecord | null>;
  /** Sets the counter and stamps `lastUsedAt` in one statement. */
  updateCounter(input: { id: string; counter: number }): Promise<void>;
  /** True when a row was deleted. */
  delete(id: string): Promise<boolean>;
}

/** Fan-out of project changes to in-process subscribers, backed by LISTEN/NOTIFY. */
export interface EventHub {
  subscribe(listener: (projectId: number) => void): Promise<() => void>;
  stats(): { subscribers: number; clients: number };
  close(): Promise<void>;
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
  labels: LabelRepository;
  relations: RelationRepository;
  tokens: TokenCodec;
  passkeys: PasskeyRepository;
  sessions: AuthSessionRepository;
  challenges: WebAuthnChallengeRepository;
}

/**
 * Ports as seen by the outside world. `transaction` runs the callback inside
 * exactly one flat transaction, handing it ports bound to that transaction.
 */
export interface Ports extends TransactionPorts {
  transaction<T>(fn: (ports: TransactionPorts) => Promise<T>): Promise<T>;
}
