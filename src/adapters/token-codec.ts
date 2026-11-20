import { createHash, randomBytes } from "node:crypto";
import type { TokenCodec } from "../application/ports.ts";

const TOKEN_PREFIX = "crv_";
const TOKEN_BYTES = 24;
// 24 random bytes encode to exactly 32 base64url characters, the session
// cookie and challenge-id shape the HTTP contract asserts.
const NONCE_BYTES = 24;

/** Mints plaintext tokens and derives the only form ever stored. */
export function createTokenCodec(): TokenCodec {
  return {
    mint(): string {
      return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
    },

    hash(token: string): string {
      return createHash("sha256").update(token, "utf8").digest("hex");
    },

    mintNonce(): string {
      return randomBytes(NONCE_BYTES).toString("base64url");
    },
  };
}
