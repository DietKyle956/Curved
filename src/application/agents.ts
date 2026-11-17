import { ServiceError } from "../domain/errors.ts";
import type { Agent, CreatedAgent } from "../domain/types.ts";
import { validateAgentName } from "../domain/validation.ts";
import type { TransactionPorts } from "./ports.ts";

/**
 * Creates an agent and returns its token exactly once. The token is never
 * recoverable afterwards; a lost token means a new agent identity.
 */
export async function createAgent(
  ports: TransactionPorts,
  name: string,
): Promise<CreatedAgent> {
  const trimmed = validateAgentName(name);
  const token = ports.tokens.mint();
  const agent = await ports.agents.create({
    name: trimmed,
    tokenHash: ports.tokens.hash(token),
  });
  return { agent, token };
}

/**
 * Resolves a plaintext token to its agent. Blank and unknown tokens fail the
 * same way so a caller cannot tell which part was wrong.
 */
export async function authenticateAgent(
  ports: TransactionPorts,
  token: string,
): Promise<Agent> {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new ServiceError("not_authenticated", "agent token is not valid");
  }
  const agent = await ports.agents.findByTokenHash(ports.tokens.hash(trimmed));
  if (agent === null) {
    throw new ServiceError("not_authenticated", "agent token is not valid");
  }
  return agent;
}

/** Asserts an agent name exists before it is written to a claim column. */
export async function ensureAgentExists(
  ports: TransactionPorts,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if ((await ports.agents.findByName(trimmed)) === null) {
    throw new ServiceError("not_found", `agent "${trimmed}" not found`);
  }
}
