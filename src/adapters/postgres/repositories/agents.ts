import type { QueryResultRow } from "pg";
import type { Db } from "../../../db.ts";
import type { AgentRepository } from "../../../application/ports.ts";

interface ExistsRow extends QueryResultRow {
  ok: number;
}

export function createAgentRepository(db: Db): AgentRepository {
  return {
    async exists(name: string): Promise<boolean> {
      const trimmed = name.trim();
      const row = await db.one<ExistsRow>(
        `select 1 as ok from agents where name = $1`,
        [trimmed],
      );
      return row !== null;
    },
  };
}
