// HTTP status mapping and the HTTP error body shape live in the HTTP adapter, never in the domain.
import type { ErrorCode } from "../../domain/errors.ts";
import { ServiceError } from "../../domain/errors.ts";

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
