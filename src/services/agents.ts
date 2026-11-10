import { createHash, randomBytes } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { Db } from "../db.ts";
import { pgErrorCode } from "../db.ts";
import { ServiceError } from "../errors.ts";

const NAME_MAX_LENGTH = 100;
const TOKEN_PREFIX = "crv_";
const TOKEN_BYTES = 24;

export interface Agent {
  id: number;
  name: string;
  createdAt: string;
}

export interface CreatedAgent {
  agent: Agent;
  token: string;
}

interface AgentRow extends QueryResultRow {
  id: number;
  name: string;
  created_at: Date;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
  };
}

/** Mints a fresh plaintext token; only its hash is ever stored. */
export function generateAgentToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** The stored form of a token: its lowercase SHA-256 hex digest. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validateName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ServiceError("validation", "agent name must not be empty");
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new ServiceError(
      "validation",
      `agent name must be at most ${NAME_MAX_LENGTH} characters, got ${name.length}`,
    );
  }
  return name;
}

/**
 * Creates an agent and returns its token exactly once. The token is never
 * recoverable afterwards; a lost token means a new agent identity.
 */
export async function createAgent(
  db: Db,
  name: string,
): Promise<CreatedAgent> {
  const trimmed = validateName(name);
  const token = generateAgentToken();

  try {
    const row = await db.one<AgentRow>(
      `insert into agents (name, token_hash)
       values ($1, $2)
       returning id, name, created_at`,
      [trimmed, hashAgentToken(token)],
    );
    if (row === null) {
      throw new Error("agent insert returned no row");
    }
    return { agent: toAgent(row), token };
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new ServiceError("duplicate", `agent "${trimmed}" already exists`);
    }
    throw error;
  }
}

/**
 * Resolves a plaintext token to its agent. Blank and unknown tokens fail the
 * same way so a caller cannot tell which part was wrong.
 */
export async function authenticateAgent(
  db: Db,
  token: string,
): Promise<Agent> {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new ServiceError("not_authenticated", "agent token is not valid");
  }
  const row = await db.one<AgentRow>(
    `select id, name, created_at
     from agents
     where token_hash = $1`,
    [hashAgentToken(trimmed)],
  );
  if (row === null) {
    throw new ServiceError("not_authenticated", "agent token is not valid");
  }
  return toAgent(row);
}

/** Asserts an agent name exists before it is written to a claim column. */
export async function ensureAgentExists(db: Db, name: string): Promise<void> {
  const trimmed = name.trim();
  const row = await db.one<AgentRow>(
    `select id, name, created_at
     from agents
     where name = $1`,
    [trimmed],
  );
  if (row === null) {
    throw new ServiceError("not_found", `agent "${trimmed}" not found`);
  }
}
