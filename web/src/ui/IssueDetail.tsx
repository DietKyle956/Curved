import {
  ArrowUUpLeft,
  ChatCircle,
  CheckCircle,
  Flag,
  Hand,
  LinkSimple,
  PaperPlaneTilt,
  PencilSimple,
  Sparkle,
  Tag,
  WarningOctagon,
} from "@phosphor-icons/react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  EVENT_LABEL,
  EVENT_TONE,
  PRIORITY_LABEL,
  STATUS_LABEL,
  absoluteTime,
  eventDetail,
  relativeTime,
} from "../domain/presentation.ts";
import type {
  EventKind,
  Issue,
  IssueEvent,
  IssueRef,
  IssueTimeline,
  Priority,
  Status,
} from "../domain/types.ts";
import {
  AgentMark,
  Button,
  CloseButton,
  Field,
  IconButton,
  PriorityMark,
  StatusChip,
} from "./ui.tsx";
import { Modal } from "./Modal.tsx";
import { RelationsDialog } from "./RelationsDialog.tsx";

function EventIcon({ kind }: { kind: EventKind }) {
  const className = `size-3 ${EVENT_TONE[kind]}`;
  switch (kind) {
    case "created":
      return <Sparkle className={className} aria-hidden="true" />;
    case "status":
      return <Flag className={className} aria-hidden="true" />;
    case "comment":
      return <ChatCircle className={className} aria-hidden="true" />;
    case "claim":
      return <Hand className={className} aria-hidden="true" />;
    case "review_submitted":
      return <PaperPlaneTilt className={className} aria-hidden="true" />;
    case "release":
      return <ArrowUUpLeft className={className} aria-hidden="true" />;
    case "blocked":
      return <WarningOctagon className={className} aria-hidden="true" />;
    case "unblocked":
      return <CheckCircle className={className} aria-hidden="true" />;
    case "labels":
      return <Tag className={className} aria-hidden="true" />;
    case "relation":
      return <LinkSimple className={className} aria-hidden="true" />;
  }
}

function TimelineEvent({
  event,
  last,
}: {
  event: IssueEvent;
  last: boolean;
}) {
  const detail = eventDetail(event);
  return (
    <li className="relative flex gap-2.5" data-testid="timeline-event" data-kind={event.kind}>
      <div className="flex flex-col items-center">
        <span className="grid size-5 shrink-0 place-items-center rounded-ui border border-line bg-panel">
          <EventIcon kind={event.kind} />
        </span>
        {!last ? <span className="mt-1 w-px flex-1 bg-line" aria-hidden="true" /> : null}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "pb-0" : "pb-4"}`}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="font-mono text-[9.5px] text-fg-muted">
            {event.actorType}
          </span>
          <span className="text-[11px] text-fg-secondary">
            {EVENT_LABEL[event.kind]}
          </span>
          <time
            dateTime={event.createdAt}
            title={absoluteTime(event.createdAt)}
            className="ml-auto font-mono text-[9px] text-fg-muted"
          >
            {relativeTime(event.createdAt)}
          </time>
        </div>
        {detail !== null && detail.length > 0 ? (
          <p
            className={`mt-1 text-[11.5px] leading-relaxed break-words whitespace-pre-wrap ${
              event.kind === "comment" ? "text-fg" : "text-fg-secondary"
            }`}
          >
            {detail}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function DetailSkeleton() {
  return (
    <div className="px-4 py-4">
      <div className="skeleton h-2.5 w-16 rounded-ui" />
      <div className="skeleton mt-3 h-4 w-4/5 rounded-ui" />
      <div className="skeleton mt-2 h-4 w-3/5 rounded-ui" />
      <div className="mt-5 flex gap-2">
        <div className="skeleton h-7 w-16 rounded-ui" />
        <div className="skeleton h-7 w-16 rounded-ui" />
      </div>
      <div className="mt-6 space-y-2">
        <div className="skeleton h-2.5 w-full rounded-ui" />
        <div className="skeleton h-2.5 w-11/12 rounded-ui" />
        <div className="skeleton h-2.5 w-4/5 rounded-ui" />
      </div>
      <div className="mt-6 space-y-3 border-t border-line pt-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex gap-2.5">
            <div className="skeleton size-5 rounded-ui" />
            <div className="flex-1 space-y-1.5">
              <div className="skeleton h-2 w-24 rounded-ui" />
              <div className="skeleton h-2.5 w-3/4 rounded-ui" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface IssueDetailProps {
  issueKey: string;
  timeline: IssueTimeline | null;
  loading: boolean;
  error: string | null;
  allLabels: string[];
  issues: Issue[];
  onClose: () => void;
  onOpenIssueKey: (key: string) => void;
  onOpenProject?: (key: string) => void;
  onRetry: () => void;
  onTransition: (key: string, status: Status) => Promise<boolean>;
  onComment: (key: string, body: string) => Promise<boolean>;
  onUpdate: (
    key: string,
    fields: { title?: string; description?: string; priority?: Priority },
  ) => Promise<boolean>;
  onSetLabels: (key: string, labels: string[]) => Promise<boolean>;
  onSaveRelations: (
    key: string,
    relations: { blocks: string[]; blockedBy: string[] },
  ) => Promise<boolean>;
  onUnblock: (key: string) => Promise<boolean>;
}

export function IssueDetail({
  issueKey,
  timeline,
  loading,
  error,
  allLabels,
  issues,
  onClose,
  onOpenIssueKey,
  onOpenProject,
  onRetry,
  onTransition,
  onComment,
  onUpdate,
  onSetLabels,
  onSaveRelations,
  onUnblock,
}: IssueDetailProps) {
  const reduce = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [moving, setMoving] = useState<Status | null>(null);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>(3);
  const [saving, setSaving] = useState(false);
  const [editingLabels, setEditingLabels] = useState(false);
  const [labelsDraft, setLabelsDraft] = useState("");
  const [savingLabels, setSavingLabels] = useState(false);
  const [editingRelations, setEditingRelations] = useState(false);
  const [unblocking, setUnblocking] = useState(false);

  const issue = timeline?.issue ?? null;

  useEffect(() => {
    setEditing(false);
    setEditingLabels(false);
    setEditingRelations(false);
    setComment("");
    setMoving(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [issueKey]);

  function startEditing(): void {
    if (issue === null) {
      return;
    }
    setTitle(issue.title);
    setDescription(issue.description);
    setPriority(issue.priority);
    setEditing(true);
  }

  async function saveEdits(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (issue === null) {
      return;
    }
    setSaving(true);
    const ok = await onUpdate(issue.key, {
      title: title.trim(),
      description,
      priority,
    });
    setSaving(false);
    if (ok) {
      setEditing(false);
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (issue === null || comment.trim().length === 0) {
      return;
    }
    setCommenting(true);
    const ok = await onComment(issue.key, comment);
    setCommenting(false);
    if (ok) {
      setComment("");
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: reduce ? "auto" : "smooth",
        });
      });
    }
  }

  async function submitLabels(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (issue === null) {
      return;
    }
    const labels = labelsDraft
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    setSavingLabels(true);
    const ok = await onSetLabels(issue.key, labels);
    setSavingLabels(false);
    if (ok) {
      setEditingLabels(false);
    }
  }

  async function transition(status: Status): Promise<void> {
    if (issue === null) {
      return;
    }
    setMoving(status);
    await onTransition(issue.key, status);
    setMoving(null);
  }

  async function unblock(): Promise<void> {
    if (issue === null) {
      return;
    }
    setUnblocking(true);
    await onUnblock(issue.key);
    setUnblocking(false);
  }

  return (
    <Modal
      open
      onClose={onClose}
      label={`Issue ${issueKey}`}
      testId="issue-detail"
      overlayClassName="z-40 items-stretch p-0 sm:items-center sm:p-6"
      panelClassName="flex h-[100dvh] w-full flex-col overflow-hidden bg-panel sm:h-[min(calc(100dvh-3rem),50rem)] sm:max-w-3xl sm:rounded-ui sm:border sm:border-line sm:shadow-float"
    >
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-line px-4 pt-[env(safe-area-inset-top)] sm:min-h-14 sm:pt-0">
        <span className="font-mono text-[11px] text-fg">{issueKey}</span>
        {issue !== null ? <StatusChip status={issue.status} /> : null}
        <div className="ml-auto flex items-center gap-1">
          {issue !== null && !editing ? (
            <IconButton
              label="Edit issue fields"
              onClick={startEditing}
              icon={<PencilSimple className="size-4" />}
            />
          ) : null}
          <CloseButton label="Close issue" onClick={onClose} />
        </div>
      </header>

      <div ref={scrollRef} className="scroll-area min-h-0 flex-1 overflow-y-auto">
        {loading && timeline === null ? (
          <DetailSkeleton />
        ) : error !== null && timeline === null ? (
          <div className="px-4 py-6">
            <p className="rounded-ui border border-storm/35 bg-storm/10 px-3 py-2 text-[12px] leading-relaxed text-storm">
              {error}
            </p>
            <Button variant="secondary" size="md" className="mt-3" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : issue === null ? (
          <div className="px-4 py-6 text-[12px] text-fg-muted">Issue not found.</div>
        ) : (
          <div className="px-4 py-4 sm:px-5 sm:py-5">
            {editing ? (
              <form
                onSubmit={(event) => void saveEdits(event)}
                className="flex flex-col gap-3"
              >
                <Field label="Title">
                  {(id) => (
                    <input
                      id={id}
                      value={title}
                      onChange={(event) => {
                        setTitle(event.target.value);
                      }}
                      className="field-input"
                      autoFocus
                      maxLength={500}
                    />
                  )}
                </Field>
                <Field label="Description">
                  {(id) => (
                    <textarea
                      id={id}
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value);
                      }}
                      className="field-input min-h-28 resize-y leading-relaxed"
                    />
                  )}
                </Field>
                <Field label="Priority">
                  {(id) => (
                    <select
                      id={id}
                      value={priority}
                      onChange={(event) => {
                        setPriority(Number(event.target.value) as Priority);
                      }}
                      className="field-input"
                    >
                      {[1, 2, 3, 4].map((value) => (
                        <option key={value} value={value}>
                          P{value} · {PRIORITY_LABEL[value as Priority]}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <div className="flex items-center gap-2">
                  <Button type="submit" variant="primary" size="md" loading={saving}>
                    Save changes
                  </Button>
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => {
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  {onOpenProject === undefined ? (
                    <span className="font-mono text-[10px] text-fg-muted">
                      {issue.projectKey}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenProject(issue.projectKey);
                      }}
                      className="rounded-[3px] font-mono text-[10px] text-fg-muted transition-colors hover:text-spice focus-visible:text-spice"
                      title={`Open ${issue.projectKey} overview`}
                    >
                      {issue.projectKey}
                    </button>
                  )}
                  <PriorityMark priority={issue.priority} showLabel />
                  {issue.claimedBy !== null ? (
                    <span className="ml-auto inline-flex items-center gap-1.5">
                      <AgentMark name={issue.claimedBy} active />
                      <span className="text-[10.5px] text-fg-secondary">
                        {issue.claimedBy}
                      </span>
                    </span>
                  ) : (
                    <span className="ml-auto font-mono text-[9.5px] text-fg-muted">
                      unclaimed
                    </span>
                  )}
                </div>

                <h1 className="mt-2 text-[17px] leading-snug font-semibold tracking-[-0.015em] text-fg text-pretty">
                  {issue.title}
                </h1>

                <p
                  className={`mt-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap ${
                    issue.description.trim().length === 0
                      ? "text-fg-muted"
                      : "text-fg-secondary"
                  }`}
                >
                  {issue.description.trim().length === 0
                    ? "No description."
                    : issue.description}
                </p>

                {issue.blockedReason !== null ? (
                  <div className="mt-4 rounded-ui border border-storm/35 bg-storm/[0.07] px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <WarningOctagon
                        className="mt-0.5 size-4 shrink-0 text-storm"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[9.5px] tracking-[0.08em] text-storm uppercase">
                          Blocked
                        </p>
                        <p className="mt-1 text-[11.5px] leading-relaxed break-words text-fg">
                          {issue.blockedReason}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex justify-end">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={unblocking}
                        onClick={() => void unblock()}
                      >
                        Unblock
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 border-y border-line py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 font-mono text-[9.5px] tracking-[0.08em] text-fg-muted uppercase">
                      Move
                    </span>
                    {issue.allowedTransitions.length === 0 ? (
                      <span className="text-[11px] text-fg-muted">
                        No moves available.
                      </span>
                    ) : (
                      issue.allowedTransitions.map((status) => (
                        <Button
                          key={status}
                          variant="secondary"
                          size="sm"
                          loading={moving === status}
                          disabled={moving !== null}
                          onClick={() => void transition(status)}
                          data-testid={"transition-" + status}
                          data-status={status}
                        >
                          {STATUS_LABEL[status]}
                        </Button>
                      ))
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-fg-muted">
                    <span>created {relativeTime(issue.createdAt)}</span>
                    <span>updated {relativeTime(issue.updatedAt)}</span>
                    {issue.relations.blockedBy.length > 0 ? (
                      <span className="text-storm">
                        {issue.relations.blockedBy.length} blocker
                        {issue.relations.blockedBy.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                </div>

                <section className="mt-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[11px] font-medium text-fg">Labels</h2>
                    {!editingLabels ? (
                      <button
                        type="button"
                        onClick={() => {
                          setLabelsDraft(issue.labels.join(", "));
                          setEditingLabels(true);
                        }}
                        className="font-mono text-[9.5px] text-fg-muted transition-colors hover:text-spice"
                      >
                        edit
                      </button>
                    ) : null}
                  </div>
                  {editingLabels ? (
                    <form
                      onSubmit={(event) => void submitLabels(event)}
                      className="mt-2 flex flex-col gap-2"
                    >
                      <input
                        value={labelsDraft}
                        onChange={(event) => {
                          setLabelsDraft(event.target.value);
                        }}
                        className="field-input font-mono text-[11px]"
                        list="project-labels"
                        placeholder="ui, api, bug"
                        aria-label="Labels, comma separated"
                        autoFocus
                      />
                      <datalist id="project-labels">
                        {allLabels.map((label) => (
                          <option key={label} value={label} />
                        ))}
                      </datalist>
                      <p className="text-[10px] leading-snug text-fg-muted">
                        Comma separated. Replaces the full label set.
                      </p>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          loading={savingLabels}
                        >
                          Save labels
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingLabels(false);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : issue.labels.length === 0 ? (
                    <p className="mt-1.5 text-[11px] text-fg-muted">No labels.</p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {issue.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded-ui border border-line bg-panel px-1.5 py-0.5 font-mono text-[9.5px] text-fg-secondary"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </section>

                <section className="mt-4 border-t border-line pt-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[11px] font-medium text-fg">Relations</h2>
                    {!editingRelations ? (
                      <button
                        type="button"
                        data-testid="edit-relations"
                        onClick={() => setEditingRelations(true)}
                        className="font-mono text-[9.5px] text-fg-muted transition-colors hover:text-spice"
                      >
                        edit
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-2 grid gap-2">
                    <RelationRow
                      label="Blocks"
                      testId="relation-blocks-row"
                      keys={issue.relations.blocks}
                      onOpen={onOpenIssueKey}
                    />
                    <RelationRow
                      label="Blocked by"
                      testId="relation-blocked-by-row"
                      keys={issue.relations.blockedBy}
                      onOpen={onOpenIssueKey}
                      tone="storm"
                    />
                  </div>
                  {editingRelations ? (
                    <RelationsDialog
                      issue={issue}
                      issues={issues}
                      onClose={() => setEditingRelations(false)}
                      onSave={onSaveRelations}
                    />
                  ) : null}
                </section>

                <section className="mt-4 border-t border-line pt-3">
                  <h2 className="text-[11px] font-medium text-fg">Hierarchy</h2>
                  <div className="mt-2 grid gap-2">
                    <RelationRow
                      label="Parent"
                      testId="issue-parent-row"
                      keys={issue.parentKey === null ? [] : [issue.parentKey]}
                      onOpen={onOpenIssueKey}
                    />
                    <IssueChildrenRow
                      children={timeline?.children ?? []}
                      onOpen={onOpenIssueKey}
                    />
                  </div>
                </section>

                <section className="mt-4 border-t border-line pt-3">
                  <h2 className="text-[11px] font-medium text-fg">
                    Timeline
                    <span className="ml-1.5 font-mono text-[9.5px] font-normal text-fg-muted">
                      {timeline?.events.length ?? 0}
                    </span>
                  </h2>
                  <ol className="mt-3">
                    {(timeline?.events ?? []).map((event, index, all) => (
                      <TimelineEvent
                        key={event.id}
                        event={event}
                        last={index === all.length - 1}
                      />
                    ))}
                  </ol>
                  {timeline === null || timeline.events.length === 0 ? (
                    <p className="text-[11px] text-fg-muted">No events.</p>
                  ) : null}
                </section>
              </>
            )}
          </div>
        )}
      </div>

      {issue !== null && !editing ? (
        <form
          onSubmit={(event) => void submitComment(event)}
          className="shrink-0 border-t border-line bg-canvas px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-4"
        >
          <label htmlFor="issue-comment" className="sr-only">
            Add a comment
          </label>
          <textarea
            id="issue-comment"
            data-testid="comment-input"
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            placeholder="Add a comment"
            className="field-input min-h-16 resize-none text-[12px] leading-relaxed"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] text-fg-muted">
              plain text
            </span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={commenting}
              disabled={comment.trim().length === 0}
              data-testid="comment-submit"
            >
              Comment
            </Button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}

function RelationRow({
  label,
  testId,
  keys,
  onOpen,
  tone = "default",
}: {
  label: string;
  testId: string;
  keys: string[];
  onOpen: (key: string) => void;
  tone?: "default" | "storm";
}) {
  return (
    <div className="flex items-start gap-3" data-testid={testId}>
      <span className="w-20 shrink-0 pt-0.5 font-mono text-[9.5px] text-fg-muted">
        {label}
      </span>
      {keys.length === 0 ? (
        <span className="text-[11px] text-fg-muted">None</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                onOpen(key);
              }}
              className={`inline-flex items-center gap-1 rounded-ui border bg-panel px-1.5 py-0.5 font-mono text-[9.5px] transition-colors ${
                tone === "storm"
                  ? "border-storm/30 text-storm hover:border-storm/60"
                  : "border-line text-fg-secondary hover:border-line-strong hover:text-fg"
              }`}
            >
              <LinkSimple className="size-2.5" aria-hidden="true" />
              {key}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IssueChildrenRow({
  children,
  onOpen,
}: {
  children: IssueRef[];
  onOpen: (key: string) => void;
}) {
  return (
    <div className="flex items-start gap-3" data-testid="issue-children-row">
      <span className="w-20 shrink-0 pt-0.5 font-mono text-[9.5px] text-fg-muted">
        Children
      </span>
      {children.length === 0 ? (
        <span className="text-[11px] text-fg-muted">None</span>
      ) : (
        <div className="flex flex-col gap-1">
          {children.map((child) => (
            <button
              key={child.key}
              type="button"
              data-testid={`issue-child-${child.key}`}
              onClick={() => {
                onOpen(child.key);
              }}
              className="flex items-center gap-1.5 rounded-ui border border-line bg-panel px-1.5 py-0.5 text-left text-[10.5px] text-fg-secondary transition-colors hover:border-line-strong hover:text-fg"
            >
              <LinkSimple className="size-2.5" aria-hidden="true" />
              <span className="font-mono text-[9.5px]">{child.key}</span>
              <span className="truncate">{child.title}</span>
              <StatusChip status={child.status} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

