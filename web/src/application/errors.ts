// The application-level error type. Adapters translate transport failures into
// it; the workspace maps it to user-facing messages and auth handling.

export class ApplicationError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(status: number | null, code: string, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.status = status;
    this.code = code;
  }
}

export function isApplicationError(value: unknown): value is ApplicationError {
  return value instanceof ApplicationError;
}

export function isUnauthorized(error: unknown): boolean {
  return isApplicationError(error) && error.status === 401;
}

export function messageOf(error: unknown): string {
  return isApplicationError(error)
    ? error.message
    : "Something went wrong. Try again.";
}
