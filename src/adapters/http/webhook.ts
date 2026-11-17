import type { Ports } from "../../application/ports.ts";
import { ServiceError } from "../../domain/errors.ts";
import { applyPullRequestEvent } from "../../application/github.ts";
import { parseGithubPayload, readGithubRawBody } from "../github/payload.ts";
import { verifyGithubSignature } from "../github/signature.ts";

const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "route not found" },
} as const;

export interface GithubWebhookOptions {
  ports: Ports;
  secret: string;
  logger?: (error: unknown) => void;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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

  const rawBody = await readGithubRawBody(request);

  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyGithubSignature(secret, rawBody, signature)) {
    throw new ServiceError("not_authenticated", "webhook signature mismatch");
  }

  const payload = parseGithubPayload(rawBody);

  const issue = await applyPullRequestEvent(
    options.ports,
    request.headers.get("x-github-event"),
    payload,
  );
  return issue === null ? json({ ok: true, ignored: true }) : json({ ok: true });
}
