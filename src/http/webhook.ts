import { createHmac } from "node:crypto";
import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { applyPullRequestEvent } from "../services/github.ts";
import { constantTimeEqual } from "./auth.ts";

const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "route not found" },
} as const;

export interface GithubWebhookOptions {
  db: Database;
  secret: string;
  logger?: (error: unknown) => void;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The `x-hub-signature-256` value for a raw body. */
export function githubSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/**
 * Handles a GitHub webhook delivery. The signature is verified against the raw
 * body before any parsing, so this path reads no cookie and no bearer token.
 */
export async function handleGithubWebhook(
  request: Request,
  options: GithubWebhookOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(NOT_FOUND_BODY, 404);
  }

  const secret = options.secret;
  if (secret.trim() === "") {
    throw new ServiceError(
      "webhook_not_configured",
      "GITHUB_WEBHOOK_SECRET is not configured",
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > WEBHOOK_BODY_LIMIT_BYTES) {
    throw new ServiceError(
      "validation",
      "request body must be at most 1 MiB",
    );
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (
    signature === null ||
    !constantTimeEqual(signature, githubSignature(secret, rawBody))
  ) {
    throw new ServiceError("not_authenticated", "webhook signature mismatch");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new ServiceError("validation", "webhook body must be valid JSON");
  }

  const issue = await applyPullRequestEvent(
    options.db,
    request.headers.get("x-github-event"),
    payload,
  );
  return issue === null ? json({ ok: true, ignored: true }) : json({ ok: true });
}
