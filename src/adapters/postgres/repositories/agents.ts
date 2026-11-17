import type { QueryResultRow } from "pg";
import type { Db } from "../pool.ts";
import { pgErrorCode } from "../pool.ts";
import type { AgentRepository } from "../../../application/ports.ts";
import { ServiceError } from "../../../domain/errors.ts";
import type { Agent } from "../../../domain/types.ts";

interface AgentRow extends QueryResultRow {
  id: number;
  name: string;
  created_at: Date;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
  };
}

export function createAgentRepository(db: Db): AgentRepository {
  return {
    async create(input): Promise<Agent> {
      try {
        const row = await db.one<AgentRow>(
          `insert into agents (name, token_hash)
       values ($1, $2)
       returning id, name, created_at`,
          [input.name, input.tokenHash],
        );
        if (row === null) {
          throw new Error("agent insert returned no row");
        }
        return toAgent(row);
      } catch (error) {
        if (pgErrorCode(error) === "23505") {
          throw new ServiceError(
            "duplicate",
            `agent "${input.name}" already exists`,
          );
        }
        throw error;
      }
    },

    async findByTokenHash(tokenHash: string): Promise<Agent | null> {
      const row = await db.one<AgentRow>(
        `select id, name, created_at
       from agents
       where token_hash = $1`,
        [tokenHash],
      );
      return row === null ? null : toAgent(row);
    },

    async findByName(name: string): Promise<Agent | null> {
      const trimmed = name.trim();
      const row = await db.one<AgentRow>(
        `select id, name, created_at
       from agents
       where name = $1`,
        [trimmed],
      );
      return row === null ? null : toAgent(row);
    },

    async acquireClaimLock(name: string): Promise<void> {
      const trimmed = name.trim();
      await db.query(`select pg_advisory_xact_lock(727275, hashtext($1))`, [
        trimmed,
      ]);
    },
  };
}
