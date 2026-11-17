import { createHmac } from "node:crypto";
import { constantTimeEqual } from "../timing-safe.ts";

/** The `x-hub-signature-256` value for a raw body. */
export function githubSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/**
 * Verifies an `x-hub-signature-256` header against the raw body. A missing
 * header never matches.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): boolean {
  return signature !== null && constantTimeEqual(signature, githubSignature(secret, rawBody));
}
