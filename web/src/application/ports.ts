// Ports the web application talks to. Adapters under web/src/adapters/
// implement them; the composition entrypoint (web/src/main.tsx) wires them.

import type { Route } from "../domain/routes.ts";
import type {
  Actor,
  Issue,
  IssueEvent,
  IssueTimeline,
  Project,
  ProjectList,
  ReadyQueue,
  Status,
} from "../domain/types.ts";

export interface IssuesChangedOptions {
  enabled: boolean;
  projectId: number | null;
  onChange: (projectId: number) => void;
}

export interface ApiPort {
  me(): Promise<{ actor: Actor }>;
  signIn(token: string): Promise<{ actor: Actor }>;
  signOut(): Promise<void>;
  projects(): Promise<ProjectList>;
  createProject(input: { key: string; name: string }): Promise<{ project: Project }>;
  issues(project: string): Promise<{ issues: Issue[] }>;
  issue(key: string): Promise<IssueTimeline>;
  ready(project: string): Promise<ReadyQueue>;
  createIssue(input: {
    project: string;
    title: string;
    description?: string;
    priority?: number;
    status?: Status;
  }): Promise<{ issue: Issue }>;
  updateIssue(
    key: string,
    input: { title?: string; description?: string; priority?: number },
  ): Promise<{ issue: Issue }>;
  transition(key: string, to: Status, body?: string): Promise<{ issue: Issue }>;
  comment(key: string, body: string): Promise<{ event: IssueEvent }>;
  setLabels(key: string, labels: string[]): Promise<{ issue: Issue }>;
  addRelation(key: string, blocking: string): Promise<{ issue: Issue }>;
  unblock(key: string): Promise<{ issue: Issue }>;
}

// The realtime stream is consumed as a hook so it can follow React's effect
// lifecycle: the EventSource adapter implements this port.
export interface RealtimePort {
  useIssuesChanged(options: IssuesChangedOptions): void;
}

export interface NavigationPort {
  route: Route;
  navigate(path: string, options?: { replace?: boolean }): void;
}
