import {
  ArrowRight,
  CheckCircle,
  LockSimple,
  WarningOctagon,
} from "@phosphor-icons/react";
import { useState } from "react";

import { relativeTime } from "../lib/presentation.ts";
import type { Issue, ReadyQueue } from "../lib/types.ts";
import {
  AgentMark,
  Button,
  EmptyState,
  PriorityMark,
  StatusChip,
} from "./ui.tsx";

export function Queue({
  issues,
  ready,
  loading,
  onOpenIssue,
  onUnblock,
  onNewIssue,
}: {
  issues: Issue[];
  ready: ReadyQueue | null;
  loading: boolean;
  onOpenIssue: (issue: Issue) => void;
  onUnblock: (key: string) => Promise<void>;
  onNewIssue: () => void;
}) {
  const [unblocking, setUnblocking] = useState<string | null>(null);

  const inFlight = issues.filter(
    (issue) =>
      issue.claimedBy !== null &&
      (issue.status === "in_progress" || issue.status === "in_review"),
  );
  const blocked = issues.filter((issue) => issue.blockedReason !== null);
  const readyIssues = ready?.ready ?? [];

  async function unblock(key: string): Promise<void> {
    setUnblocking(key);
    try {
      await onUnblock(key);
    } finally {
      setUnblocking(null);
    }
  }

  return (
    <div className="scroll-area min-h-0 flex-1 overflow-y-auto pb-20 lg:pb-6">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[19px] leading-tight font-semibold tracking-[-0.02em] text-fg">
              Ready queue
            </h1>
            <p className="mt-1.5 max-w-[64ch] text-[12px] leading-relaxed text-fg-secondary">
              Unblocked Todo issues in claim order. A blocked issue stays out, and
              one agent can hold only one active claim.
            </p>
          </div>
          <Button variant="secondary" size="md" onClick={onNewIssue}>
            New issue
          </Button>
        </div>

        <dl className="mt-5 grid grid-cols-3 divide-x divide-line border-y border-line">
          <div className="px-0 py-3 pr-4">
            <dt className="font-mono text-[9.5px] tracking-[0.1em] text-fg-muted uppercase">
              Ready
            </dt>
            <dd className="mt-1 font-mono text-[24px] leading-none text-fg">
              {loading ? "-" : readyIssues.length}
            </dd>
          </div>
          <div className="px-4 py-3">
            <dt className="font-mono text-[9.5px] tracking-[0.1em] text-fg-muted uppercase">
              In flight
            </dt>
            <dd className="mt-1 font-mono text-[24px] leading-none text-fg">
              {loading ? "-" : inFlight.length}
            </dd>
          </div>
          <div className="py-3 pl-4">
            <dt className="font-mono text-[9.5px] tracking-[0.1em] text-fg-muted uppercase">
              Blocked
            </dt>
            <dd
              className={`mt-1 font-mono text-[24px] leading-none ${
                blocked.length > 0 ? "text-storm" : "text-fg"
              }`}
            >
              {loading ? "-" : blocked.length}
            </dd>
          </div>
        </dl>
      </div>

      <div className="grid gap-4 px-4 pb-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[12px] font-medium text-fg">Claim order</h2>
            <span className="font-mono text-[9.5px] text-fg-muted">
              priority, then number
            </span>
          </div>

          <div className="rounded-ui border border-line bg-panel">
            {loading ? (
              <div className="space-y-px p-3">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="flex items-center gap-3 py-2.5">
                    <div className="skeleton size-5 rounded-ui" />
                    <div className="skeleton h-3 w-14 rounded-ui" />
                    <div className="skeleton h-3 flex-1 rounded-ui" />
                  </div>
                ))}
              </div>
            ) : readyIssues.length === 0 ? (
              <EmptyState
                className="py-10"
                icon={<CheckCircle className="size-5" aria-hidden="true" />}
                title="Queue is clear"
                body="Every Todo issue is either blocked or already in flight. New Todo issues land here in claim order."
                action={
                  <Button variant="secondary" size="sm" onClick={onNewIssue}>
                    New issue
                  </Button>
                }
              />
            ) : (
              <ol className="divide-y divide-line">
                {readyIssues.map((issue, index) => (
                  <li key={issue.key}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenIssue(issue);
                      }}
                      className="group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-elevated/40"
                    >
                      <span className="w-5 shrink-0 font-mono text-[10px] text-fg-muted">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-fg-muted">
                            {issue.key}
                          </span>
                          <PriorityMark priority={issue.priority} />
                          {issue.labels.slice(0, 2).map((label) => (
                            <span
                              key={label}
                              className="hidden font-mono text-[9px] text-fg-muted sm:inline"
                            >
                              {label}
                            </span>
                          ))}
                        </span>
                        <span className="mt-1 block truncate text-[12.5px] font-medium text-fg">
                          {issue.title}
                        </span>
                      </span>
                      <span className="hidden shrink-0 font-mono text-[9.5px] text-fg-muted sm:block">
                        {relativeTime(issue.updatedAt)}
                      </span>
                      <ArrowRight
                        className="size-3.5 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:text-spice"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="mt-3 flex items-start gap-2 rounded-ui border border-line bg-panel px-3 py-2.5">
            <LockSimple
              className="mt-0.5 size-3.5 shrink-0 text-fg-muted"
              aria-hidden="true"
            />
            <p className="text-[11px] leading-relaxed text-fg-muted">
              Claim order is resolved in one transaction with row locks, so two
              agents cannot take the same issue. The partial unique index is the
              final fence.
            </p>
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-4">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[12px] font-medium text-fg">In flight</h2>
              <span className="font-mono text-[9.5px] text-fg-muted">
                {inFlight.length}
              </span>
            </div>
            <div className="rounded-ui border border-line bg-panel">
              {inFlight.length === 0 ? (
                <p className="px-3 py-4 text-[11.5px] leading-relaxed text-fg-muted">
                  No agent has an active claim in this project.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {inFlight.map((issue) => (
                    <li key={issue.key}>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenIssue(issue);
                        }}
                        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-elevated/40"
                      >
                        <AgentMark
                          name={issue.claimedBy ?? "?"}
                          active
                          className="mt-0.5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11.5px] font-medium text-fg">
                            {issue.claimedBy}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-muted">
                            {issue.key} · {issue.title}
                          </span>
                        </span>
                        <StatusChip status={issue.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[12px] font-medium text-fg">Blocked</h2>
              <span className="font-mono text-[9.5px] text-fg-muted">
                {blocked.length}
              </span>
            </div>
            <div className="rounded-ui border border-line bg-panel">
              {blocked.length === 0 ? (
                <p className="px-3 py-4 text-[11.5px] leading-relaxed text-fg-muted">
                  Nothing is blocked.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {blocked.map((issue) => (
                    <li key={issue.key} className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          onOpenIssue(issue);
                        }}
                        className="flex w-full items-start gap-2 text-left"
                      >
                        <WarningOctagon
                          className="mt-0.5 size-3.5 shrink-0 text-storm"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-[9.5px] text-fg-muted">
                            {issue.key}
                          </span>
                          <span className="mt-0.5 block text-[11.5px] leading-snug text-fg">
                            {issue.blockedReason}
                          </span>
                        </span>
                      </button>
                      <div className="mt-2 flex justify-end">
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={unblocking === issue.key}
                          onClick={() => void unblock(issue.key)}
                        >
                          Unblock
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
