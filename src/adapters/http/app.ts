import { resolve } from "node:path";
import { ServiceError } from "../../domain/errors.ts";
import { errorBody, httpStatusFor } from "./errors.ts";
import { blockIssue, unblockIssue } from "../../application/blocking.ts";
import { commentOnIssue } from "../../application/comments.ts";
import {
  createIssue,
  getIssueTimeline,
  listIssues,
  moveIssue,
  updateIssue,
} from "../../application/issues.ts";
import type { IssueContext } from "../../domain/actors.ts";
import { setIssueLabels } from "../../application/labels.ts";
import {
  deletePasskey,
  finishPasskeyLogin,
  finishPasskeyRegistration,
  listPasskeys,
  passkeysAvailable,
  startPasskeyLogin,
  startPasskeyRegistration,
} from "../../application/passkeys.ts";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnConfig,
} from "../../application/passkeys.ts";
import type { Ports } from "../../application/ports.ts";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
} from "../../application/projects.ts";
import { claimNext, listReady, releaseClaim } from "../../application/queue.ts";
import { addRelation } from "../../application/relations.ts";
import { createSession } from "../../application/sessions.ts";
import {
  parseCookies,
  resolveActor,
  resolveSessionActor,
  SESSION_COOKIE_NAME,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "./auth.ts";
import type { AuthContext } from "./auth.ts";
import type { EventHub } from "../../application/ports.ts";
import { constantTimeEqual } from "../timing-safe.ts";
import { serveSpa } from "../static/spa.ts";
import { createEventStreamResponse } from "../sse/stream.ts";
import { handleGithubWebhook } from "./webhook.ts";

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;
const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "route not found" },
} as const;

/** Local development origins; composition overrides this in production. */
const DEFAULT_WEBAUTHN: WebAuthnConfig = {
  rpID: "localhost",
  origins: ["http://localhost:4747", "http://localhost:5173"],
};

export interface CreateAppOptions {
  ports: Ports;
  events: EventHub;
  uiToken: string;
  webauthn?: WebAuthnConfig;
  webhookSecret?: string;
  webDistDir?: string;
  eventPingIntervalMs?: number;
  cookieSecure?: boolean;
  logger?: (error: unknown) => void;
}

export interface App {
  handle(request: Request): Promise<Response>;
}

function json(
  payload: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  const responseHeaders = new Headers();
  if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) {
      responseHeaders.set(name, value);
    }
  }
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") {
    throw new ServiceError("validation", `"${name}" must be a string`);
  }
  return value;
}

function optionalStringField(
  body: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ServiceError("validation", `"${name}" must be a string`);
  }
  return value;
}

function objectField(
  body: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const value = body[name];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("validation", `"${name}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArrayField(
  body: Record<string, unknown>,
  name: string,
): string[] {
  const value = body[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ServiceError(
      "validation",
      `"${name}" must be an array of strings`,
    );
  }
  return value;
}

function optionalNumberField(
  body: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ServiceError("validation", `"${name}" must be an integer`);
  }
  return value;
}

function nullableStringField(
  body: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ServiceError("validation", `"${name}" must be a string`);
  }
  return value;
}

function nullableNumberField(
  body: Record<string, unknown>,
  name: string,
): number | null | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ServiceError("validation", `"${name}" must be an integer`);
  }
  return value;
}

function optionalBooleanField(
  body: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ServiceError("validation", `"${name}" must be a boolean`);
  }
  return value;
}

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function issueContext(auth: AuthContext): IssueContext {
  return auth.agentName === null
    ? { actor: auth.serviceActor }
    : { actor: auth.serviceActor, agent: auth.agentName };
}

function requireHuman(auth: AuthContext): void {
  if (auth.actor.type !== "human") {
    throw new ServiceError(
      "forbidden_transition",
      "this action is restricted to humans",
    );
  }
}

function requireAgent(auth: AuthContext): string {
  if (auth.actor.type !== "agent" || auth.agentName === null) {
    throw new ServiceError(
      "forbidden_transition",
      "this action is restricted to agents",
    );
  }
  return auth.agentName;
}

/**
 * Reads a JSON object body. Mutating requests with a body must declare
 * `application/json`; an empty body reads as `{}`. Bodies are capped at 1 MiB.
 */
async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > JSON_BODY_LIMIT_BYTES) {
      throw new ServiceError(
        "validation",
        "request body must be at most 1 MiB",
      );
    }
  }

  const text = await request.text();
  if (text.length === 0) {
    return {};
  }
  if (text.length > JSON_BODY_LIMIT_BYTES) {
    throw new ServiceError("validation", "request body must be at most 1 MiB");
  }

  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ServiceError(
      "validation",
      'request body must be sent with Content-Type application/json',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceError("validation", "request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ServiceError("validation", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function createApp(options: CreateAppOptions): App {
  if (options.uiToken === "") {
    throw new Error("CURVED_UI_TOKEN is required to start the HTTP app");
  }

  const { ports, uiToken, events, cookieSecure = false } = options;
  const webauthn = options.webauthn ?? DEFAULT_WEBAUTHN;
  const webDistDir = options.webDistDir ?? resolve(process.cwd(), "web/dist");
  const logger =
    options.logger ??
    ((error: unknown) => {
      console.error(error);
    });

  async function handleApi(request: Request, url: URL): Promise<Response> {
    const method = request.method;
    const segments = url.pathname.slice("/api/".length).split("/");
    const resource = segments[0];
    const key = segments[1];
    const action = segments[2];

    // Authentication is lazy so unknown routes stay 404 rather than 401.
    let authPromise: Promise<AuthContext> | null = null;
    const auth = (): Promise<AuthContext> => {
      authPromise ??= resolveActor(request, { ports, uiToken });
      return authPromise;
    };

    let bodyPromise: Promise<Record<string, unknown>> | null = null;
    const requestBody = (): Promise<Record<string, unknown>> => {
      bodyPromise ??= readJsonBody(request);
      return bodyPromise;
    };

    if (resource === "events") {
      if (key !== undefined || method !== "GET") {
        return json(NOT_FOUND_BODY, 404);
      }
      // EventSource cannot send headers, so the stream only accepts the
      // session cookie; a missing or wrong cookie is a plain 401.
      await resolveSessionActor(request, { ports });
      return createEventStreamResponse({
        request,
        hub: events,
        pingIntervalMs: options.eventPingIntervalMs,
        logger,
      });
    }

    if (resource === "session") {
      if (key === "passkey") {
        if (action === "options") {
          if (method !== "POST") {
            return json(NOT_FOUND_BODY, 404);
          }
          return json(await startPasskeyLogin(ports, webauthn));
        }
        if (action === undefined && method === "POST") {
          const body = await requestBody();
          const session = await finishPasskeyLogin(ports, webauthn, {
            challengeId: stringField(body, "challengeId"),
            response: objectField(
              body,
              "response",
            ) as unknown as AuthenticationResponseJSON,
          });
          return json(
            { actor: { type: "human", name: null } },
            200,
            {
              "set-cookie": serializeSessionCookie(
                session.cookieValue,
                cookieSecure,
              ),
            },
          );
        }
        return json(NOT_FOUND_BODY, 404);
      }
      if (key !== undefined) {
        return json(NOT_FOUND_BODY, 404);
      }
      if (method === "POST") {
        const body = await requestBody();
        const token = optionalStringField(body, "token");
        if (token === undefined || !constantTimeEqual(token, uiToken)) {
          throw new ServiceError("not_authenticated", "token is not valid");
        }
        const session = await createSession(ports, {
          method: "token",
          credentialId: null,
        });
        return json(
          { actor: { type: "human", name: null } },
          200,
          {
            "set-cookie": serializeSessionCookie(
              session.cookieValue,
              cookieSecure,
            ),
          },
        );
      }
      if (method === "DELETE") {
        await auth();
        const cookie = parseCookies(
          request.headers.get("cookie"),
        ).get(SESSION_COOKIE_NAME);
        if (cookie !== undefined) {
          await ports.sessions.deleteByTokenHash(ports.tokens.hash(cookie));
        }
        return new Response(null, {
          status: 204,
          headers: {
            "set-cookie": serializeClearedSessionCookie(cookieSecure),
          },
        });
      }
      return json(NOT_FOUND_BODY, 404);
    }

    if (resource === "passkeys") {
      if (key === "available") {
        if (action !== undefined || method !== "GET") {
          return json(NOT_FOUND_BODY, 404);
        }
        return json(
          { available: await passkeysAvailable(ports) },
          200,
          { "cache-control": "no-store" },
        );
      }
      if (key === "options") {
        if (action !== undefined || method !== "POST") {
          return json(NOT_FOUND_BODY, 404);
        }
        requireHuman(await auth());
        return json(await startPasskeyRegistration(ports, webauthn));
      }
      if (key === undefined) {
        if (method === "GET") {
          requireHuman(await auth());
          return json({ passkeys: await listPasskeys(ports) });
        }
        if (method === "POST") {
          requireHuman(await auth());
          const body = await requestBody();
          const passkey = await finishPasskeyRegistration(ports, webauthn, {
            challengeId: stringField(body, "challengeId"),
            nickname: optionalStringField(body, "nickname") ?? "Passkey",
            response: objectField(
              body,
              "response",
            ) as unknown as RegistrationResponseJSON,
          });
          return json({ passkey }, 201);
        }
        return json(NOT_FOUND_BODY, 404);
      }
      if (action === undefined && method === "DELETE") {
        requireHuman(await auth());
        await deletePasskey(ports, decodeURIComponent(key));
        return new Response(null, { status: 204 });
      }
      return json(NOT_FOUND_BODY, 404);
    }

    if (resource === "me") {
      if (key !== undefined || method !== "GET") {
        return json(NOT_FOUND_BODY, 404);
      }
      const authContext = await auth();
      return json({ actor: authContext.actor });
    }

    if (resource === "projects") {
      if (key === undefined) {
        if (method === "GET") {
          await auth();
          const includeArchived =
            queryParam(url, "includeArchived") === "true";
          return json({
            projects: await listProjects(ports, { includeArchived }),
          });
        }
        if (method === "POST") {
          requireHuman(await auth());
          const body = await requestBody();
          const project = await createProject(ports, {
            key: stringField(body, "key"),
            name: stringField(body, "name"),
            summary: optionalStringField(body, "summary"),
            description: optionalStringField(body, "description"),
            status: optionalStringField(body, "status"),
            priority: nullableNumberField(body, "priority"),
            startDate: nullableStringField(body, "startDate"),
            targetDate: nullableStringField(body, "targetDate"),
          });
          return json({ project }, 201);
        }
        return json(NOT_FOUND_BODY, 404);
      }

      if (action === undefined) {
        const authContext = await auth();
        if (method === "GET") {
          return json({ project: await getProject(ports, key) });
        }
        if (method === "PATCH") {
          requireHuman(authContext);
          const body = await requestBody();
          if (body.key !== undefined) {
            throw new ServiceError(
              "validation",
              "a project key cannot change",
            );
          }
          const project = await updateProject(ports, {
            key,
            name: optionalStringField(body, "name"),
            summary: optionalStringField(body, "summary"),
            description: optionalStringField(body, "description"),
            status: optionalStringField(body, "status"),
            priority: nullableNumberField(body, "priority"),
            startDate: nullableStringField(body, "startDate"),
            targetDate: nullableStringField(body, "targetDate"),
            archived: optionalBooleanField(body, "archived"),
            actor: authContext.serviceActor,
            agent: authContext.agentName ?? undefined,
          });
          return json({ project });
        }
        return json(NOT_FOUND_BODY, 404);
      }

      return json(NOT_FOUND_BODY, 404);
    }

    if (resource === "issues") {
      if (key === undefined) {
        if (method === "GET") {
          const authContext = await auth();
          const issues = await listIssues(
            ports,
            {
              project: queryParam(url, "project"),
              status: queryParam(url, "status"),
            },
            issueContext(authContext),
          );
          return json({ issues });
        }
        if (method === "POST") {
          const authContext = await auth();
          const body = await requestBody();
          const issue = await createIssue(ports, {
            project: stringField(body, "project"),
            title: stringField(body, "title"),
            description: optionalStringField(body, "description"),
            priority: optionalNumberField(body, "priority"),
            status: optionalStringField(body, "status"),
            parent: optionalStringField(body, "parent"),
            actor: authContext.serviceActor,
          });
          return json({ issue }, 201);
        }
        return json(NOT_FOUND_BODY, 404);
      }

      if (action === undefined) {
        const authContext = await auth();
        if (method === "GET") {
          return json(
            await getIssueTimeline(ports, key, issueContext(authContext)),
          );
        }
        if (method === "PATCH") {
          requireHuman(authContext);
          const body = await requestBody();
          if (body.project !== undefined) {
            throw new ServiceError(
              "validation",
              "an issue's project cannot change",
            );
          }
          const issue = await updateIssue(ports, {
            key,
            title: optionalStringField(body, "title"),
            description: optionalStringField(body, "description"),
            priority: optionalNumberField(body, "priority"),
            actor: authContext.serviceActor,
            agent: authContext.agentName ?? undefined,
          });
          return json({ issue });
        }
        return json(NOT_FOUND_BODY, 404);
      }

      if (action === "transition" && method === "POST") {
        const authContext = await auth();
        const body = await requestBody();
        const issue = await moveIssue(ports, {
          key,
          to: stringField(body, "to"),
          body: optionalStringField(body, "body"),
          actor: authContext.serviceActor,
          agent: authContext.agentName ?? undefined,
        });
        return json({ issue });
      }

      if (action === "comments" && method === "POST") {
        const authContext = await auth();
        const body = await requestBody();
        const event = await commentOnIssue(ports, {
          key,
          body: stringField(body, "body"),
          actor: authContext.serviceActor,
          agent: authContext.agentName ?? undefined,
        });
        return json({ event }, 201);
      }

      if (action === "labels" && method === "POST") {
        requireHuman(await auth());
        const body = await requestBody();
        const issue = await setIssueLabels(ports, {
          key,
          labels: stringArrayField(body, "labels"),
          actor: "human",
        });
        return json({ issue });
      }

      if (action === "relations" && method === "POST") {
        requireHuman(await auth());
        const body = await requestBody();
        const issue = await addRelation(ports, {
          blocked: key,
          blocking: stringField(body, "blocking"),
          actor: "human",
        });
        return json({ issue });
      }

      if (action === "block" && method === "POST") {
        const agentName = requireAgent(await auth());
        const body = await requestBody();
        const issue = await blockIssue(ports, {
          key,
          agent: agentName,
          reason: stringField(body, "reason"),
        });
        return json({ issue });
      }

      if (action === "unblock" && method === "POST") {
        requireHuman(await auth());
        await requestBody();
        const issue = await unblockIssue(ports, { key, actor: "human" });
        return json({ issue });
      }

      if (action === "release" && method === "POST") {
        const agentName = requireAgent(await auth());
        await requestBody();
        const issue = await releaseClaim(ports, { key, agent: agentName });
        return json({ issue });
      }

      return json(NOT_FOUND_BODY, 404);
    }

    if (resource === "ready") {
      if (key !== undefined || method !== "GET") {
        return json(NOT_FOUND_BODY, 404);
      }
      const authContext = await auth();
      const queue = await listReady(
        ports,
        { project: queryParam(url, "project") },
        issueContext(authContext),
      );
      return json(queue);
    }

    if (resource === "claims") {
      if (key !== "next" || action !== undefined || method !== "POST") {
        return json(NOT_FOUND_BODY, 404);
      }
      const agentName = requireAgent(await auth());
      await requestBody();
      const issue = await claimNext(
        ports,
        { project: queryParam(url, "project") },
        agentName,
      );
      return json({ issue }, 201);
    }

    return json(NOT_FOUND_BODY, 404);
  }

  async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/webhooks/github") {
        return await handleGithubWebhook(request, {
          ports,
          secret: options.webhookSecret ?? "",
          logger,
        });
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return await handleApi(request, url);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await serveSpa(request, webDistDir);
      }
      return json(NOT_FOUND_BODY, 404);
    } catch (error) {
      if (error instanceof ServiceError) {
        return json(errorBody(error), httpStatusFor(error.code));
      }
      logger(error);
      return json(
        { error: { code: "internal", message: "Internal server error" } },
        500,
      );
    }
  }

  return { handle };
}
