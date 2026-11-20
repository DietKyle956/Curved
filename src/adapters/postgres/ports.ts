import type { Database, Db } from "./pool.ts";
import type { Ports, TransactionPorts } from "../../application/ports.ts";
import { createAgentRepository } from "./repositories/agents.ts";
import { createAuthSessionRepository } from "./repositories/auth-sessions.ts";
import { createEventRepository } from "./repositories/issue-events.ts";
import { createIssueMetaRepository } from "./repositories/issue-meta.ts";
import { createIssueRepository } from "./repositories/issues.ts";
import { createLabelRepository } from "./repositories/labels.ts";
import { createPasskeyChallengeRepository } from "./repositories/passkey-challenges.ts";
import { createPasskeyRepository } from "./repositories/passkeys.ts";
import { createProjectRepository } from "./repositories/projects.ts";
import { createRelationRepository } from "./repositories/relations.ts";
import { createTokenCodec } from "../token-codec.ts";

/** Wires every port to a single database handle, transactional or not. */
export function bindPorts(db: Db): TransactionPorts {
  return {
    projects: createProjectRepository(db),
    issues: createIssueRepository(db),
    events: createEventRepository(db),
    meta: createIssueMetaRepository(db),
    agents: createAgentRepository(db),
    labels: createLabelRepository(db),
    relations: createRelationRepository(db),
    tokens: createTokenCodec(),
    passkeys: createPasskeyRepository(db),
    sessions: createAuthSessionRepository(db),
    challenges: createPasskeyChallengeRepository(db),
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
