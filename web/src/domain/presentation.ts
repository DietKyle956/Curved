import { PROJECT_STATUSES, STATUSES } from "../../../src/domain/status.ts";
import type {
  EventKind,
  Issue,
  Priority,
  ProjectProgress,
  ProjectStatus,
  Status,
} from "./types.ts";

export const STATUS_LABEL: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export const STATUS_ORDER: readonly Status[] = STATUSES;

interface Tone {
  text: string;
  bg: string;
  border: string;
  mark: string;
}

export const STATUS_TONE: Record<Status, Tone> = {
  backlog: {
    text: "text-fg-muted",
    bg: "bg-fg-muted/10",
    border: "border-fg-muted/25",
    mark: "bg-fg-muted",
  },
  todo: {
    text: "text-fremen",
    bg: "bg-fremen/10",
    border: "border-fremen/30",
    mark: "bg-fremen",
  },
  in_progress: {
    text: "text-spice",
    bg: "bg-spice/10",
    border: "border-spice/30",
    mark: "bg-spice",
  },
  in_review: {
    text: "text-rose",
    bg: "bg-rose/10",
    border: "border-rose/30",
    mark: "bg-rose",
  },
  done: {
    text: "text-oasis",
    bg: "bg-oasis/10",
    border: "border-oasis/30",
    mark: "bg-oasis",
  },
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

export const PRIORITY_TONE: Record<Priority, string> = {
  1: "text-storm",
  2: "text-ember",
  3: "text-fg-secondary",
  4: "text-fg-muted",
};

export const PROJECT_STATUS_ORDER: readonly ProjectStatus[] = PROJECT_STATUSES;

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  backlog: "Backlog",
  planned: "Planned",
  in_progress: "In progress",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
};

export const PROJECT_STATUS_TONE: Record<ProjectStatus, Tone> = {
  backlog: {
    text: "text-fg-muted",
    bg: "bg-fg-muted/10",
    border: "border-fg-muted/25",
    mark: "bg-fg-muted",
  },
  planned: {
    text: "text-fremen",
    bg: "bg-fremen/10",
    border: "border-fremen/30",
    mark: "bg-fremen",
  },
  in_progress: {
    text: "text-spice",
    bg: "bg-spice/10",
    border: "border-spice/30",
    mark: "bg-spice",
  },
  paused: {
    text: "text-ember",
    bg: "bg-ember/10",
    border: "border-ember/30",
    mark: "bg-ember",
  },
  completed: {
    text: "text-oasis",
    bg: "bg-oasis/10",
    border: "border-oasis/30",
    mark: "bg-oasis",
  },
  canceled: {
    text: "text-fg-muted",
    bg: "bg-fg-muted/10",
    border: "border-fg-muted/25",
    mark: "bg-fg-muted",
  },
};

export function projectPriorityLabel(priority: Priority | null): string {
  return priority === null ? "No priority" : PRIORITY_LABEL[priority];
}

export function projectProgressPercent(progress: ProjectProgress): number {
  return progress.total === 0
    ? 0
    : Math.round((progress.done / progress.total) * 100);
}

export const EVENT_LABEL: Record<EventKind, string> = {
  created: "created this issue",
  status: "moved the issue",
  comment: "commented",
  claim: "claimed this issue",
  review_submitted: "submitted for review",
  release: "released this issue",
  blocked: "blocked this issue",
  unblocked: "unblocked this issue",
  labels: "changed labels",
  relation: "changed a relation",
};

export const EVENT_TONE: Record<EventKind, string> = {
  created: "text-fg-muted",
  status: "text-spice",
  comment: "text-fg-secondary",
  claim: "text-fremen",
  review_submitted: "text-rose",
  release: "text-fg-muted",
  blocked: "text-storm",
  unblocked: "text-oasis",
  labels: "text-fg-muted",
  relation: "text-fg-muted",
};

export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);
  const first = words[0]?.slice(0, 1) ?? "?";
  const second = words.length > 1 ? (words[1]?.slice(0, 1) ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

export function matchesQuery(issue: Issue, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [
    issue.key,
    issue.title,
    issue.description,
    issue.claimedBy ?? "",
    ...issue.labels,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export function sortForColumn(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (left, right) =>
      left.priority - right.priority || left.number - right.number,
  );
}

export function countByStatus(issues: Issue[]): Record<Status, number> {
  const counts: Record<Status, number> = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  };
  for (const issue of issues) {
    counts[issue.status] += 1;
  }
  return counts;
}

export interface RelationCandidate {
  key: string;
  title: string;
}

export function relationCandidates(
  issues: readonly Issue[],
  options: { excludeKey?: string; includeKeys?: readonly string[] } = {},
): RelationCandidate[] {
  const titles = new Map(issues.map((issue) => [issue.key, issue.title]));
  const selected = new Set<string>();
  for (const issue of issues) {
    if (issue.status !== "done" && issue.key !== options.excludeKey) {
      selected.add(issue.key);
    }
  }
  for (const key of options.includeKeys ?? []) {
    if (key !== options.excludeKey) {
      selected.add(key);
    }
  }
  return [...selected]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((key) => ({ key, title: titles.get(key) ?? "" }));
}

export function parentCandidates(issues: readonly Issue[]): RelationCandidate[] {
  return [...issues]
    .sort((left, right) => left.number - right.number)
    .map((issue) => ({ key: issue.key, title: issue.title }));
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "unknown";
  }
  const seconds = Math.round((then - Date.now()) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 45) {
    return "just now";
  }
  if (magnitude < 3600) {
    return relative.format(Math.round(seconds / 60), "minute");
  }
  if (magnitude < 86_400) {
    return relative.format(Math.round(seconds / 3600), "hour");
  }
  if (magnitude < 2_592_000) {
    return relative.format(Math.round(seconds / 86_400), "day");
  }
  return absolute.format(new Date(then));
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : absolute.format(date);
}

export function eventDetail(event: {
  kind: EventKind;
  fromStatus: Status | null;
  toStatus: Status | null;
  body: string | null;
}): string | null {
  if (event.kind === "comment") {
    return event.body;
  }
  if (event.kind === "blocked") {
    return event.body;
  }
  if (event.kind === "review_submitted") {
    return event.body;
  }
  if (event.kind === "status" && event.fromStatus !== null && event.toStatus !== null) {
    return `${STATUS_LABEL[event.fromStatus]} to ${STATUS_LABEL[event.toStatus]}`;
  }
  if (event.kind === "claim" && event.toStatus !== null) {
    return STATUS_LABEL[event.toStatus];
  }
  if (event.kind === "labels" && event.body !== null) {
    const labels = parseJsonLabels(event.body);
    return labels === null
      ? event.body
      : labels.length === 0
        ? "No labels"
        : labels.join(", ");
  }
  if (event.kind === "relation" && event.body !== null) {
    return relationSummary(event.body);
  }
  return null;
}

function parseJsonLabels(body: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const candidate =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { labels?: unknown }).labels
        : parsed;
    if (
      Array.isArray(candidate) &&
      candidate.every((item) => typeof item === "string")
    ) {
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

function relationSummary(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const removed = (parsed as { removed?: unknown }).removed === true;
      const blocking = (parsed as { blocking?: unknown }).blocking;
      const blocked = (parsed as { blocked?: unknown }).blocked;
      if (typeof blocking === "string" && typeof blocked === "string") {
        return removed
          ? `${blocking} no longer blocks ${blocked}`
          : `${blocking} now blocks ${blocked}`;
      }
    }
  } catch {
    // Fall through to the raw body.
  }
  return body;
}
