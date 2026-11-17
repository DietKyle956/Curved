import type { Project } from "../domain/types.ts";

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
  tokens: TokenCodec;
}

/**
 * Ports as seen by the outside world. `transaction` runs the callback inside
 * exactly one flat transaction, handing it ports bound to that transaction.
 */
export interface Ports extends TransactionPorts {
  transaction<T>(fn: (ports: TransactionPorts) => Promise<T>): Promise<T>;
}
