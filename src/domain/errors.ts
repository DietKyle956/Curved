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
