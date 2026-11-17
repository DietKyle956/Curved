import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares two secrets without leaking their contents through timing. Both
 * sides are hashed first so the comparison length is fixed regardless of the
 * input lengths.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
