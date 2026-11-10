import { resolve } from "node:path";
import type { Database } from "../db.ts";
import { ServiceError, errorBody, httpStatusFor } from "../errors.ts";
import { blockIssue, unblockIssue } from "../services/blocking.ts";
import { commentOnIssue } from "../services/comments.ts";
import {
  createIssue,
  getIssueTimeline,
  listIssues,
  moveIssue,
  updateIssue,
} from "../services/issues.ts";
import type { IssueContext } from "../services/issues.ts";
import { setIssueLabels } from "../services/labels.ts";
import { createProject, listProjects } from "../services/projects.ts";
import { claimNext, listReady, releaseClaim } from "../services/queue.ts";
import { addRelation } from "../services/relations.ts";
import {
  constantTimeEqual,
  resolveActor,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionCookieValue,
} from "./auth.ts";
import type { AuthContext } from "./auth.ts";
import { serveSpa } from "./spa.ts";

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;
const NOT_FOUND_BODY = {
  error: { code: "not_found", message: "route not found" },
} as const;

export interface CreateAppOptions {
  db: Database;
  uiToken: string;
  webDistDir?: string;
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

  const { db, uiToken } = options;
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
      authPromise ??= resolveActor(request, { db, uiToken });
      return authPromise;
    };

    let bodyPromise: Promise<Record<string, unknown>> | null = null;
    const requestBody = (): Promise<Record<string, unknown>> => {
      bodyPromise ??= readJsonBody(request);
      return bodyPromise;
    };

    if (resource === "session") {
      if (key !== undefined) {
        return json(NOT_FOUND_BODY, 404);
      }
      if (method === "POST") {
        const body = await requestBody();
        const token = optionalStringField(body, "token");
        if (token === undefined || !constantTimeEqual(token, uiToken)) {
          throw new ServiceError("not_authenticated", "token is not valid");
        }
        return json(
          { actor: { type: "human", name: null } },
          200,
          { "set-cookie": serializeSessionCookie(sessionCookieValue(uiToken)) },
        );
      }
      if (method === "DELETE") {
        await auth();
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": serializeClearedSessionCookie() },
        });
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
      if (key !== undefined) {
        return json(NOT_FOUND_BODY, 404);
      }
      if (method === "GET") {
        await auth();
        return json({ projects: await listProjects(db) });
      }
      if (method === "POST") {
        requireHuman(await auth());
        const body = await requestBody();
        const project = await createProject(db, {
          key: stringField(body, "key"),
          name: stringField(body, "name"),
        });
        return json({ project }, 201);
      }
      return json(NOT_FOUND_BODY, 404);
    }

    if (resource === "issues") {
      if (key === undefined) {
        if (method === "GET") {
          const authContext = await auth();
          const issues = await listIssues(
            db,
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
          const issue = await createIssue(db, {
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
          return json(await getIssueTimeline(db, key, issueContext(authContext)));
        }
        if (method === "PATCH") {
          requireHuman(authContext);
          const body = await requestBody();
          const issue = await updateIssue(db, {
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
        const issue = await moveIssue(db, {
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
        const event = await commentOnIssue(db, {
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
        const issue = await setIssueLabels(db, {
          key,
          labels: stringArrayField(body, "labels"),
          actor: "human",
        });
        return json({ issue });
      }

      if (action === "relations" && method === "POST") {
        requireHuman(await auth());
        const body = await requestBody();
        const issue = await addRelation(db, {
          blocked: key,
          blocking: stringField(body, "blocking"),
          actor: "human",
        });
        return json({ issue });
      }

      if (action === "block" && method === "POST") {
        const agentName = requireAgent(await auth());
        const body = await requestBody();
        const issue = await blockIssue(db, {
          key,
          agent: agentName,
          reason: stringField(body, "reason"),
        });
        return json({ issue });
      }

      if (action === "unblock" && method === "POST") {
        requireHuman(await auth());
        await requestBody();
        const issue = await unblockIssue(db, { key, actor: "human" });
        return json({ issue });
      }

      if (action === "release" && method === "POST") {
        const agentName = requireAgent(await auth());
        await requestBody();
        const issue = await releaseClaim(db, { key, agent: agentName });
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
        db,
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
        db,
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
