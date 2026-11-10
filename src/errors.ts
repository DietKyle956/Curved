export const ERROR_CODES = [
  "validation",
  "not_found",
  "illegal_transition",
  "forbidden_transition",
  "agent_busy",
  "no_ready_issue",
  "duplicate",
  "not_authenticated",
  "webhook_not_configured",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  validation: 400,
  not_authenticated: 401,
  forbidden_transition: 403,
  not_found: 404,
  illegal_transition: 409,
  agent_busy: 409,
  no_ready_issue: 409,
  duplicate: 409,
  webhook_not_configured: 503,
};

/**
 * A failure with a stable, machine-readable code. Adapters (HTTP, MCP, CLI)
 * render the code and never invent their own error shape.
 */
export class ServiceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function errorBody(error: unknown): ErrorBody {
  if (error instanceof ServiceError) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: "internal", message: "Internal server error" } };
}
