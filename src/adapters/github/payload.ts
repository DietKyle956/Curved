import { ServiceError } from "../../domain/errors.ts";

export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

/** Reads the raw webhook body; the signature is verified against these bytes. */
export async function readGithubRawBody(request: Request): Promise<string> {
  const rawBody = await request.text();
  if (rawBody.length > WEBHOOK_BODY_LIMIT_BYTES) {
    throw new ServiceError(
      "validation",
      "request body must be at most 1 MiB",
    );
  }
  return rawBody;
}

/**
 * Parses a webhook body. Bodies that are not valid JSON are a validation
 * failure, not a transport error.
 */
export function parseGithubPayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new ServiceError("validation", "webhook body must be valid JSON");
  }
}
