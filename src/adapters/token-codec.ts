import { createHash, randomBytes } from "node:crypto";
import type { TokenCodec } from "../application/ports.ts";

const TOKEN_PREFIX = "crv_";
const TOKEN_BYTES = 24;

/** Mints plaintext tokens and derives the only form ever stored. */
export function createTokenCodec(): TokenCodec {
  return {
    mint(): string {
      return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
    },

    hash(token: string): string {
      return createHash("sha256").update(token, "utf8").digest("hex");
    },
  };
}
