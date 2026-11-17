import type { Database, Db } from "../../db.ts";
import type { Ports, TransactionPorts } from "../../application/ports.ts";
import { createAgentRepository } from "./repositories/agents.ts";
import { createEventRepository } from "./repositories/issue-events.ts";
import { createIssueMetaRepository } from "./repositories/issue-meta.ts";
import { createIssueRepository } from "./repositories/issues.ts";
import { createProjectRepository } from "./repositories/projects.ts";
import { createTokenCodec } from "../token-codec.ts";

/** Wires every port to a single database handle, transactional or not. */
export function bindPorts(db: Db): TransactionPorts {
  return {
    projects: createProjectRepository(db),
    issues: createIssueRepository(db),
    events: createEventRepository(db),
    meta: createIssueMetaRepository(db),
    agents: createAgentRepository(db),
    tokens: createTokenCodec(),
  };
}

export function createPorts(database: Database): Ports {
  return {
    ...bindPorts(database),
    transaction<T>(fn: (ports: TransactionPorts) => Promise<T>): Promise<T> {
      return database.tx((db) => fn(bindPorts(db)));
    },
  };
}
