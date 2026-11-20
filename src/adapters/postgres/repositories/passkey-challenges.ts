import type { QueryResultRow } from "pg";
import type { Db } from "../pool.ts";
import type {
  WebAuthnChallengeKind,
  WebAuthnChallengeRepository,
} from "../../../application/ports.ts";

interface ChallengeRow extends QueryResultRow {
  challenge: string;
}

export function createPasskeyChallengeRepository(
  db: Db,
): WebAuthnChallengeRepository {
  return {
    async create(input): Promise<void> {
      await db.query(
        `insert into webauthn_challenges (id, challenge, kind, expires_at)
         values ($1, $2, $3, $4)`,
        [input.id, input.challenge, input.kind, input.expiresAt],
      );
    },

    async consume(input: {
      id: string;
      kind: WebAuthnChallengeKind;
      now: Date;
    }): Promise<string | null> {
      const row = await db.one<ChallengeRow>(
        `delete from webauthn_challenges
         where id = $1 and kind = $2 and expires_at > $3
         returning challenge`,
        [input.id, input.kind, input.now],
      );
      return row === null ? null : row.challenge;
    },

    async deleteExpired(now: Date): Promise<void> {
      await db.query(`delete from webauthn_challenges where expires_at <= $1`, [
        now,
      ]);
    },
  };
}
