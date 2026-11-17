import type { Database, Db } from "../../db.ts";
import type { Ports, TransactionPorts } from "../../application/ports.ts";
import { createProjectRepository } from "./repositories/projects.ts";
import { createTokenCodec } from "../token-codec.ts";

function bind(db: Db): TransactionPorts {
  return {
    projects: createProjectRepository(db),
    tokens: createTokenCodec(),
  };
}

export function createPorts(database: Database): Ports {
  return {
    ...bind(database),
    transaction<T>(fn: (ports: TransactionPorts) => Promise<T>): Promise<T> {
      return database.tx((db) => fn(bind(db)));
    },
  };
}
