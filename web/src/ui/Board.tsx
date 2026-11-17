import {
  ArrowRight,
  LinkSimple,
  Plus,
  WarningOctagon,
} from "@phosphor-icons/react";
import { useState } from "react";

import {
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_TONE,
  countByStatus,
  matchesQuery,
  relativeTime,
  sortForColumn,
} from "../domain/presentation.ts";
import type { Issue, Status } from "../domain/types.ts";
import {
  AgentMark,
  Button,
  EmptyState,
  IconButton,
  PriorityMark,
  StatusChip,
} from "./ui.tsx";

export function IssueCard({
  issue,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging = false,
}: {
  issue: Issue;
  onOpen: (issue: Issue) => void;
  onDragStart?: (issue: Issue) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}) {
  const visibleLabels = issue.labels.slice(0, 2);
  const hiddenLabels = issue.labels.length - visibleLabels.length;
  const relationCount =
    issue.relations.blocks.length + issue.relations.blockedBy.length;

  return (
    <article
      data-testid={`issue-card-${issue.key}`}
      draggable={onDragStart !== undefined}
      onDragStart={
        onDragStart === undefined
          ? undefined
          : (event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", issue.key);
              onDragStart(issue);
            }
      }
      onDragEnd={onDragEnd}
      className={`group rounded-ui border border-line bg-panel transition-[background-color,border-color,transform,opacity] duration-150 hover:-translate-y-px hover:border-line-strong ${
        dragging ? "opacity-40" : ""
      } ${issue.status === "done" ? "bg-panel/60" : ""}`}
    >
      <button
        type="button"
        onClick={() => {
          onOpen(issue);
        }}
        className="block w-full rounded-ui p-2.5 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-fg-muted">{issue.key}</span>
          <PriorityMark priority={issue.priority} />
          {issue.blockedReason !== null ? (
            <span
              title="Blocked"
              className="inline-flex items-center gap-1 font-mono text-[9px] text-storm"
            >
              <WarningOctagon className="size-3" aria-hidden="true" />
              blocked
            </span>
          ) : null}
          <span className="ml-auto">
            {issue.claimedBy !== null ? (
              <AgentMark name={issue.claimedBy} active />
            ) : null}
          </span>
        </div>

        <p
          title={issue.title}
          className={`mt-2 line-clamp-2 text-[12.5px] leading-snug font-medium tracking-[-0.005em] ${
            issue.status === "done" ? "text-fg-secondary" : "text-fg"
          }`}
        >
          {issue.title}
        </p>

        {visibleLabels.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {visibleLabels.map((label) => (
              <span
                key={label}
                className="rounded-ui border border-line bg-elevated px-1.5 py-0.5 font-mono text-[9px] leading-none text-fg-muted"
              >
                {label}
              </span>
            ))}
            {hiddenLabels > 0 ? (
              <span className="font-mono text-[9px] text-fg-muted">
                +{hiddenLabels}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-2.5 flex items-center gap-2.5 text-fg-muted">
          {relationCount > 0 ? (
            <span className="inline-flex items-center gap-1 font-mono text-[9px]">
              <LinkSimple className="size-3" aria-hidden="true" />
              {relationCount}
            </span>
          ) : null}
          <span className="ml-auto font-mono text-[9px]">
            {relativeTime(issue.updatedAt)}
          </span>
        </div>
      </button>
    </article>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-4 pb-4 lg:px-5">
      {STATUS_ORDER.map((status) => (
        <div key={status} className="flex w-[248px] shrink-0 flex-col gap-2">
          <div className="flex items-center gap-2 py-2">
            <div className="skeleton size-1.5 rounded-[1px]" />
            <div className="skeleton h-2.5 w-16 rounded-ui" />
            <div className="skeleton ml-auto h-2.5 w-4 rounded-ui" />
          </div>
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="rounded-ui border border-line bg-panel p-2.5"
            >
              <div className="skeleton h-2 w-12 rounded-ui" />
              <div className="skeleton mt-2.5 h-2.5 w-full rounded-ui" />
              <div className="skeleton mt-1.5 h-2.5 w-3/4 rounded-ui" />
              <div className="skeleton mt-3 h-2 w-20 rounded-ui" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface BoardProps {
  issues: Issue[];
  query: string;
  labelFilter: string | null;
  readyCount: number;
  loading: boolean;
  onOpenIssue: (issue: Issue) => void;
  onMove: (key: string, status: Status) => void;
  onNewIssue: (status?: Status) => void;
  onClearFilters: () => void;
  onOpenQueue: () => void;
}

const MOBILE_STATUS_WEIGHT: Record<Status, number> = {
  in_progress: 0,
  in_review: 1,
  todo: 2,
  backlog: 3,
  done: 4,
};

function sortForMobile(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (left, right) =>
      MOBILE_STATUS_WEIGHT[left.status] - MOBILE_STATUS_WEIGHT[right.status] ||
      left.priority - right.priority ||
      left.number - right.number,
  );
}

export function Board({
  issues,
  query,
  labelFilter,
  readyCount,
  loading,
  onOpenIssue,
  onMove,
  onNewIssue,
  onClearFilters,
  onOpenQueue,
}: BoardProps) {
  const [dragged, setDragged] = useState<Issue | null>(null);
  const [mobileStatus, setMobileStatus] = useState<"all" | Status>("all");

  const visible = issues.filter(
    (issue) =>
      matchesQuery(issue, query) &&
      (labelFilter === null || issue.labels.includes(labelFilter)),
  );
  const counts = countByStatus(visible);
  const mobileIssues =
    mobileStatus === "all"
      ? sortForMobile(visible)
      : sortForColumn(visible.filter((issue) => issue.status === mobileStatus));
  if (loading) {
    return <BoardSkeleton />;
  }

  if (issues.length === 0) {
    return (
      <EmptyState
        testId="board-empty"
        className="flex-1"
        icon={<Plus className="size-5" aria-hidden="true" />}
        title="No issues yet"
        body="Capture the first issue. Agents claim from Todo, and every move lands in the timeline."
        action={
          <Button variant="primary" size="md" onClick={() => onNewIssue()}>
            New issue
          </Button>
        }
      />
    );
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        testId="board-empty"
        className="flex-1"
        icon={<Plus className="size-5" aria-hidden="true" />}
        title="No issues match"
        body="Clear the search or label filter to see the full board."
        action={
          <Button variant="secondary" size="md" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 lg:hidden">
        <span className="font-mono text-[10px] text-fg-muted">
          {mobileStatus === "all"
            ? `${visible.length} visible`
            : `${STATUS_LABEL[mobileStatus]} · ${counts[mobileStatus]}`}
        </span>
        {labelFilter !== null ? (
          <span className="inline-flex items-center gap-1 rounded-ui border border-line bg-panel px-1.5 py-0.5 font-mono text-[9px] text-fg-secondary">
            label: {labelFilter}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onOpenQueue}
          className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-spice"
        >
          {readyCount} ready
          <ArrowRight className="size-3" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pb-[calc(7.5rem+env(safe-area-inset-bottom))] lg:hidden">
        <div className="divide-y divide-line">
          {mobileIssues.length === 0 ? (
            <p
              data-testid="board-empty"
              className="px-1 py-8 text-center text-[11.5px] text-fg-muted"
            >
              No issues in this status. Tap the active tab again to show all
              issues.
            </p>
          ) : null}
          {mobileIssues.map((issue) => (
            <button
              key={issue.key}
              type="button"
              data-testid={`issue-row-${issue.key}`}
              onClick={() => {
                onOpenIssue(issue);
              }}
              className="flex w-full items-start gap-3 py-3 text-left"
            >
              <span className="mt-0.5 font-mono text-[10px] text-fg-muted">
                {issue.key}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug font-medium text-fg">
                  {issue.title}
                </span>
                <span className="mt-1.5 flex flex-wrap items-center gap-2">
                  <StatusChip status={issue.status} />
                  <PriorityMark priority={issue.priority} />
                  {issue.blockedReason !== null ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[9px] text-storm">
                      <WarningOctagon className="size-3" aria-hidden="true" />
                      blocked
                    </span>
                  ) : null}
                  {issue.labels.slice(0, 2).map((label) => (
                    <span
                      key={label}
                      className="font-mono text-[9px] text-fg-muted"
                    >
                      {label}
                    </span>
                  ))}
                  {issue.claimedBy !== null ? (
                    <span className="ml-auto inline-flex items-center gap-1">
                      <AgentMark name={issue.claimedBy} active />
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Sits directly above the shell's MobileNav (h-14 + safe area). */}
      <nav
        aria-label="Filter board by status"
        className="fixed inset-x-0 bottom-[calc(3.5625rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-canvas/95 backdrop-blur-sm lg:hidden"
      >
        <div className="grid grid-cols-5">
          {STATUS_ORDER.map((status) => {
            const active = mobileStatus === status;
            return (
              <button
                key={status}
                type="button"
                data-testid={`status-tab-${status}`}
                data-status={status}
                data-count={counts[status]}
                onClick={() => {
                  setMobileStatus(active ? "all" : status);
                }}
                aria-pressed={active}
                className={`relative flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 text-[10px] transition-colors ${
                  active
                    ? "bg-elevated/60 text-fg"
                    : "text-fg-muted hover:text-fg"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-3 top-0 h-px transition-colors ${
                    active ? "bg-spice" : "bg-transparent"
                  }`}
                />
                <span className="px-0.5 text-center leading-tight">
                  {STATUS_LABEL[status]}
                </span>
                <span className="flex items-center gap-1 leading-none">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-[1px] ${STATUS_TONE[status].mark} ${
                      active ? "" : "opacity-60"
                    }`}
                  />
                  <span className="font-mono text-[9px] tabular-nums">
                    {counts[status]}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="hidden min-h-0 min-w-0 flex-1 gap-4 overflow-x-auto px-4 pb-4 lg:flex lg:px-5">
        {STATUS_ORDER.map((status) => {
          const columnIssues = sortForColumn(
            visible.filter((issue) => issue.status === status),
          );
          const canDrop =
            dragged !== null &&
            dragged.status !== status &&
            dragged.allowedTransitions.includes(status);
          return (
            <section
              key={status}
              aria-label={STATUS_LABEL[status]}
              className={`group flex min-h-0 w-[240px] shrink-0 flex-col rounded-ui border border-transparent transition-colors duration-150 xl:w-auto xl:min-w-[210px] xl:flex-1 ${
                canDrop ? "border-spice/30 bg-spice/[0.025]" : ""
              }`}
              onDragOver={(event) => {
                if (canDrop) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                } else if (dragged !== null) {
                  event.dataTransfer.dropEffect = "none";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== null && canDrop) {
                  onMove(dragged.key, status);
                }
                setDragged(null);
              }}
            >
              <div className="flex h-9 shrink-0 items-center gap-2 px-2">
                <span
                  className={`size-1.5 rounded-[1px] ${STATUS_TONE[status].mark}`}
                  aria-hidden="true"
                />
                <h2 className="text-[11.5px] font-medium text-fg-secondary">
                  {STATUS_LABEL[status]}
                </h2>
                <span className="font-mono text-[10px] text-fg-muted">
                  {columnIssues.length}
                </span>
                {status === "backlog" || status === "todo" ? (
                  <IconButton
                    label={`New ${STATUS_LABEL[status]} issue`}
                    size="sm"
                    onClick={() => {
                      onNewIssue(status);
                    }}
                    icon={<Plus className="size-3.5" />}
                    className="ml-auto opacity-50 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  />
                ) : null}
              </div>

              <div className="scroll-area flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-0.5 pb-2">
                {columnIssues.map((issue) => (
                  <IssueCard
                    key={issue.key}
                    issue={issue}
                    onOpen={onOpenIssue}
                    onDragStart={setDragged}
                    onDragEnd={() => {
                      setDragged(null);
                    }}
                    dragging={dragged?.key === issue.key}
                  />
                ))}
                {columnIssues.length === 0 ? (
                  <div
                    className={`flex min-h-20 items-center justify-center rounded-ui border border-dashed px-3 text-center text-[10.5px] leading-snug ${
                      canDrop
                        ? "border-spice/40 text-spice"
                        : "border-line/80 text-fg-muted"
                    }`}
                  >
                    {canDrop ? "Drop to move" : "No issues"}
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
