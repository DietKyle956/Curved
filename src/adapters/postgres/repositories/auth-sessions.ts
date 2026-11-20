import type { QueryResultRow } from "pg";
import type { Db } from "../pool.ts";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  SessionMethod,
} from "../../../application/ports.ts";

interface AuthSessionRow extends QueryResultRow {
  token_hash: string;
  method: string;
  credential_id: string | null;
  created_at: Date;
  expires_at: Date;
}

function toAuthSession(row: AuthSessionRow): AuthSessionRecord {
  return {
    tokenHash: row.token_hash,
    method: row.method as SessionMethod,
    credentialId: row.credential_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createAuthSessionRepository(db: Db): AuthSessionRepository {
  return {
    async create(input): Promise<AuthSessionRecord> {
      const row = await db.one<AuthSessionRow>(
        `insert into auth_sessions (token_hash, method, credential_id, expires_at)
         values ($1, $2, $3, $4)
         returning token_hash, method, credential_id, created_at, expires_at`,
        [input.tokenHash, input.method, input.credentialId, input.expiresAt],
      );
      if (row === null) {
        throw new Error("auth session insert returned no row");
      }
      return toAuthSession(row);
    },

    async findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
      const row = await db.one<AuthSessionRow>(
        `select token_hash, method, credential_id, created_at, expires_at
         from auth_sessions
         where token_hash = $1 and expires_at > now()`,
        [tokenHash],
      );
      return row === null ? null : toAuthSession(row);
    },

    async deleteByTokenHash(tokenHash: string): Promise<void> {
      await db.query(`delete from auth_sessions where token_hash = $1`, [
        tokenHash,
      ]);
    },

    async deleteExpired(now: Date): Promise<void> {
      await db.query(`delete from auth_sessions where expires_at <= $1`, [now]);
    },
  };
}
