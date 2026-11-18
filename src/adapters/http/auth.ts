import { createHash } from "node:crypto";
import { ServiceError } from "../../domain/errors.ts";
import type { ActorType } from "../../domain/status.ts";
import { authenticateAgent } from "../../application/agents.ts";
import type { Ports } from "../../application/ports.ts";
import { constantTimeEqual } from "../timing-safe.ts";

export const SESSION_COOKIE_NAME = "curved_session";
export const SESSION_MAX_AGE_SECONDS = 2592000;

/** The public identity attached to every authenticated HTTP request. */
export interface Actor {
  type: "human" | "agent";
  name: string | null;
}

/**
 * The resolved request identity plus the service-layer context it maps to.
 * `serviceActor` is the string form the services validate; `agentName` is only
 * set for agent requests.
 */
export interface AuthContext {
  actor: Actor;
  serviceActor: ActorType;
  agentName: string | null;
}

/** Lowercase SHA-256 hex digest, the stored form of every secret. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The session cookie value for a UI token. */
export function sessionCookieValue(uiToken: string): string {
  return sha256Hex(uiToken);
}

export function serializeSessionCookie(value: string, secure = false): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function serializeClearedSessionCookie(secure = false): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

/** Parses a Cookie header into a name to value map; malformed pairs are skipped. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === null) {
    return cookies;
  }
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    if (name.length === 0 || cookies.has(name)) {
      continue;
    }
    const rawValue = pair.slice(separator + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }
    cookies.set(name, value);
  }
  return cookies;
}

/**
 * Resolves a UI session from the session cookie alone. EventSource cannot send
 * an Authorization header, so this path never consults one: a bearer-only
 * request is unauthenticated even when its token is valid.
 */
export function resolveSessionActor(
  request: Request,
  options: { uiToken: string },
): AuthContext {
  const cookies = parseCookies(request.headers.get("cookie"));
  const cookie = cookies.get(SESSION_COOKIE_NAME);
  if (
    cookie !== undefined &&
    constantTimeEqual(cookie, sessionCookieValue(options.uiToken))
  ) {
    return {
      actor: { type: "human", name: null },
      serviceActor: "human",
      agentName: null,
    };
  }
  throw new ServiceError("not_authenticated", "authentication required");
}

/**
 * Resolves the request identity. An Authorization header is authoritative:
 * when it is present but invalid the request is rejected even if a valid
 * session cookie accompanies it.
 */
export async function resolveActor(
  request: Request,
  options: { ports: Ports; uiToken: string },
): Promise<AuthContext> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
    if (match === null) {
      throw new ServiceError("not_authenticated", "invalid bearer credentials");
    }
    const token = match[1] ?? "";
    if (token.length > 0 && constantTimeEqual(token, options.uiToken)) {
      return { actor: { type: "human", name: null }, serviceActor: "human", agentName: null };
    }
    const agent = await authenticateAgent(options.ports, token);
    return {
      actor: { type: "agent", name: agent.name },
      serviceActor: "agent",
      agentName: agent.name,
    };
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  const cookie = cookies.get(SESSION_COOKIE_NAME);
  if (cookie !== undefined && constantTimeEqual(cookie, sessionCookieValue(options.uiToken))) {
    return { actor: { type: "human", name: null }, serviceActor: "human", agentName: null };
  }

  throw new ServiceError("not_authenticated", "authentication required");
}
