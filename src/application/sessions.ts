import type { SessionMethod, TransactionPorts } from "./ports.ts";

/** Browser sessions live for thirty days; the cookie mirrors this. */
export const SESSION_MAX_AGE_SECONDS = 2592000;

export interface CreatedSession {
  cookieValue: string;
  expiresAt: Date;
}

/**
 * Starts a server-side session for the human operator and returns the
 * plaintext nonce for the cookie. Only the nonce's hash is persisted, so a
 * database leak cannot be replayed as a cookie.
 */
export async function createSession(
  ports: TransactionPorts,
  input: { method: SessionMethod; credentialId: string | null },
): Promise<CreatedSession> {
  const cookieValue = ports.tokens.mintNonce();
  const tokenHash = ports.tokens.hash(cookieValue);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await ports.sessions.deleteExpired(new Date());
  await ports.sessions.create({
    tokenHash,
    method: input.method,
    credentialId: input.credentialId,
    expiresAt,
  });
  return { cookieValue, expiresAt };
}
