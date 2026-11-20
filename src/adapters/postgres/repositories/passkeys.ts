import type { QueryResultRow } from "pg";
import type { Db } from "../pool.ts";
import { pgErrorCode } from "../pool.ts";
import type { PasskeyRecord, PasskeyRepository } from "../../../application/ports.ts";
import { ServiceError } from "../../../domain/errors.ts";

interface PasskeyRow extends QueryResultRow {
  id: string;
  public_key: Buffer;
  counter: string | number;
  transports: string[] | null;
  device_type: string;
  backed_up: boolean;
  nickname: string;
  created_at: Date;
  last_used_at: Date | null;
}

const PASSKEY_COLUMNS = `id, public_key, counter, transports, device_type, backed_up, nickname, created_at, last_used_at`;

interface CountRow extends QueryResultRow {
  count: number;
}

interface IdRow extends QueryResultRow {
  id: string;
}

function toPasskey(row: PasskeyRow): PasskeyRecord {
  return {
    id: row.id,
    publicKey: new Uint8Array(row.public_key),
    counter: Number.parseInt(String(row.counter), 10),
    transports: row.transports ?? [],
    deviceType: row.device_type as PasskeyRecord["deviceType"],
    backedUp: row.backed_up,
    nickname: row.nickname,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function createPasskeyRepository(db: Db): PasskeyRepository {
  return {
    async create(input): Promise<PasskeyRecord> {
      try {
        const row = await db.one<PasskeyRow>(
          `insert into passkey_credentials
             (id, public_key, counter, transports, device_type, backed_up, nickname)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning ${PASSKEY_COLUMNS}`,
          [
            input.id,
            Buffer.from(input.publicKey),
            input.counter,
            input.transports,
            input.deviceType,
            input.backedUp,
            input.nickname,
          ],
        );
        if (row === null) {
          throw new Error("passkey insert returned no row");
        }
        return toPasskey(row);
      } catch (error) {
        if (pgErrorCode(error) === "23505") {
          throw new ServiceError(
            "duplicate",
            "this passkey is already registered",
          );
        }
        throw error;
      }
    },

    async list(): Promise<PasskeyRecord[]> {
      const rows = await db.query<PasskeyRow>(
        `select ${PASSKEY_COLUMNS}
         from passkey_credentials
         order by created_at asc, id asc`,
      );
      return rows.map(toPasskey);
    },

    async count(): Promise<number> {
      const row = await db.one<CountRow>(
        `select count(*)::int as count from passkey_credentials`,
      );
      return row === null ? 0 : row.count;
    },

    async findById(id: string): Promise<PasskeyRecord | null> {
      const row = await db.one<PasskeyRow>(
        `select ${PASSKEY_COLUMNS}
         from passkey_credentials
         where id = $1`,
        [id],
      );
      return row === null ? null : toPasskey(row);
    },

    async updateCounter(input: { id: string; counter: number }): Promise<void> {
      const row = await db.one<IdRow>(
        `update passkey_credentials
         set counter = $2, last_used_at = now()
         where id = $1
         returning id`,
        [input.id, input.counter],
      );
      if (row === null) {
        throw new Error("passkey counter update returned no row");
      }
    },

    async delete(id: string): Promise<boolean> {
      const row = await db.one<IdRow>(
        `delete from passkey_credentials where id = $1 returning id`,
        [id],
      );
      return row !== null;
    },
  };
}
