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

function errorName(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    typeof error.name === "string"
  ) {
    return error.name;
  }
  return null;
}

export function passkeyErrorMessage(error: unknown): string {
  if (isApplicationError(error)) {
    return error.message;
  }
  switch (errorName(error)) {
    case "NotAllowedError":
      return "Passkey request was cancelled or timed out.";
    case "InvalidStateError":
      return "This device already has a passkey for Curved.";
    case "NotSupportedError":
      return "This browser does not support passkeys.";
    default:
      return "Passkey request failed. Try again.";
  }
}
