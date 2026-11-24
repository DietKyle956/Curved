// HTTP adapter for the backend API. Every transport failure becomes an
// ApplicationError so the application layer never sees a raw Response.

import { ApplicationError } from "../application/errors.ts";
import type { ApiPort } from "../application/ports.ts";
import type {
  Actor,
  Issue,
  IssueEvent,
  IssueTimeline,
  NewProjectInput,
  PasskeySummary,
  Project,
  ProjectList,
  ProjectPatch,
  ReadyQueue,
  Status,
} from "../domain/types.ts";

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers:
        options.body === undefined
          ? { accept: "application/json" }
          : {
              accept: "application/json",
              "content-type": "application/json",
            },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApplicationError(
      0,
      "network",
      "Could not reach the server. Check that it is running.",
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    let code = "internal";
    let message = `Request failed with status ${response.status}.`;
    if (payload !== null && typeof payload === "object" && "error" in payload) {
      const error: unknown = payload.error;
      if (error !== null && typeof error === "object") {
        if ("code" in error && typeof error.code === "string") {
          code = error.code;
        }
        if ("message" in error && typeof error.message === "string") {
          message = error.message;
        }
      }
    }
    throw new ApplicationError(response.status, code, message);
  }

  return payload as T;
}

function issuePath(key: string): string {
  return `/api/issues/${encodeURIComponent(key)}`;
}

export function createApiClient(): ApiPort {
  return {
    me(): Promise<{ actor: Actor }> {
      return request("/api/me");
    },

    signIn(token: string): Promise<{ actor: Actor }> {
      return request("/api/session", { method: "POST", body: { token } });
    },

    signOut(): Promise<void> {
      return request("/api/session", { method: "DELETE" });
    },

    projects(): Promise<ProjectList> {
      return request("/api/projects?includeArchived=true");
    },

    project(key: string): Promise<{ project: Project }> {
      return request(`/api/projects/${encodeURIComponent(key)}`);
    },

    createProject(input: NewProjectInput): Promise<{ project: Project }> {
      return request("/api/projects", { method: "POST", body: input });
    },

    updateProject(
      key: string,
      patch: ProjectPatch,
    ): Promise<{ project: Project }> {
      return request(`/api/projects/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: patch,
      });
    },

    issues(project: string): Promise<{ issues: Issue[] }> {
      return request(`/api/issues?project=${encodeURIComponent(project)}`);
    },

    issue(key: string): Promise<IssueTimeline> {
      return request(issuePath(key));
    },

    ready(project: string): Promise<ReadyQueue> {
      return request(`/api/ready?project=${encodeURIComponent(project)}`);
    },

    createIssue(input: {
      project: string;
      title: string;
      description?: string;
      priority?: number;
      status?: Status;
      parent?: string;
    }): Promise<{ issue: Issue }> {
      return request("/api/issues", { method: "POST", body: input });
    },

    updateIssue(
      key: string,
      input: { title?: string; description?: string; priority?: number },
    ): Promise<{ issue: Issue }> {
      return request(issuePath(key), { method: "PATCH", body: input });
    },

    transition(
      key: string,
      to: Status,
      body?: string,
    ): Promise<{ issue: Issue }> {
      return request(`${issuePath(key)}/transition`, {
        method: "POST",
        body: body === undefined ? { to } : { to, body },
      });
    },

    comment(key: string, body: string): Promise<{ event: IssueEvent }> {
      return request(`${issuePath(key)}/comments`, {
        method: "POST",
        body: { body },
      });
    },

    setLabels(key: string, labels: string[]): Promise<{ issue: Issue }> {
      return request(`${issuePath(key)}/labels`, {
        method: "POST",
        body: { labels },
      });
    },

    addRelation(key: string, blocking: string): Promise<{ issue: Issue }> {
      return request(`${issuePath(key)}/relations`, {
        method: "POST",
        body: { blocking },
      });
    },

    removeRelation(key: string, blocking: string): Promise<{ issue: Issue }> {
      return request(
        `${issuePath(key)}/relations/${encodeURIComponent(blocking)}`,
        { method: "DELETE" },
      );
    },

    unblock(key: string): Promise<{ issue: Issue }> {
      return request(`${issuePath(key)}/unblock`, { method: "POST" });
    },

    passkeyAvailable(): Promise<{ available: boolean; otherDomain: number }> {
      return request("/api/passkeys/available");
    },

    startPasskeyRegistration(): Promise<{ challengeId: string; options: unknown }> {
      return request("/api/passkeys/options", { method: "POST" });
    },

    finishPasskeyRegistration(input: {
      challengeId: string;
      nickname: string;
      response: unknown;
    }): Promise<{ passkey: PasskeySummary }> {
      return request("/api/passkeys", { method: "POST", body: input });
    },

    passkeys(): Promise<{ passkeys: PasskeySummary[] }> {
      return request("/api/passkeys");
    },

    deletePasskey(id: string): Promise<void> {
      return request(`/api/passkeys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },

    startPasskeyLogin(): Promise<{ challengeId: string; options: unknown }> {
      return request("/api/session/passkey/options", { method: "POST" });
    },

    finishPasskeyLogin(input: {
      challengeId: string;
      response: unknown;
    }): Promise<{ actor: Actor }> {
      return request("/api/session/passkey", { method: "POST", body: input });
    },
  };
}
