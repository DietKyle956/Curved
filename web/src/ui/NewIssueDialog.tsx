import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import {
  parentCandidates,
  PRIORITY_LABEL,
  relationCandidates,
  STATUS_LABEL,
} from "../domain/presentation.ts";
import type {
  Issue,
  NewIssueInput,
  Priority,
  Project,
  Status,
} from "../domain/types.ts";
import { Dialog } from "./Dialog.tsx";
import { RelationSelect } from "./RelationSelect.tsx";
import { Button, Field } from "./ui.tsx";

export function NewIssueDialog({
  open,
  project,
  defaultStatus,
  allLabels,
  issues,
  onClose,
  onCreate,
}: {
  open: boolean;
  project: Project;
  defaultStatus: Status;
  allLabels: string[];
  issues: Issue[];
  onClose: () => void;
  onCreate: (input: NewIssueInput) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>(3);
  const [status, setStatus] = useState<Status>("backlog");
  const [parent, setParent] = useState("");
  const [labels, setLabels] = useState("");
  const [blocks, setBlocks] = useState<string[]>([]);
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const candidates = relationCandidates(issues);
  const parentOptions = parentCandidates(issues);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle("");
    setDescription("");
    setPriority(3);
    setStatus(defaultStatus === "todo" ? "todo" : "backlog");
    setParent("");
    setLabels("");
    setBlocks([]);
    setBlockedBy([]);
    setError(null);
    setSubmitting(false);
  }, [open, defaultStatus]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (title.trim().length === 0) {
      setError("Enter a title.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const ok = await onCreate({
      title: title.trim(),
      description,
      priority,
      status,
      parent: parent === "" ? undefined : parent,
      labels: labels
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label.length > 0),
      blocks,
      blockedBy,
    });
    setSubmitting(false);
    if (ok) {
      onClose();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New issue"
      description={`Create in ${project.name}. The key is allocated on save.`}
      size="md"
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3.5">
        <Field label="Title" error={error ?? undefined}>
          {(id) => (
            <input
              id={id}
              data-testid="new-issue-title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              className="field-input"
              placeholder="What needs to happen?"
              autoFocus
              maxLength={500}
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : `${id}-error`}
            />
          )}
        </Field>

        <Field label="Description">
          {(id) => (
            <textarea
              id={id}
              data-testid="new-issue-description"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="field-input min-h-24 resize-y leading-relaxed"
              placeholder="Context, constraints, acceptance criteria."
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            {(id) => (
              <select
                id={id}
                data-testid="new-issue-priority"
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
          <Field label="Status" hint="Agents claim from Todo.">
            {(id) => (
              <select
                id={id}
                data-testid="new-issue-status"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as Status);
                }}
                className="field-input"
              >
                <option value="backlog">{STATUS_LABEL.backlog}</option>
                <option value="todo">{STATUS_LABEL.todo}</option>
              </select>
            )}
          </Field>
        </div>

        <Field
          label="Parent"
          hint="Optional. Creates this issue as a child of the parent."
        >
          {(id) => (
            <select
              id={id}
              data-testid="new-issue-parent"
              value={parent}
              onChange={(event) => setParent(event.target.value)}
              className="field-input"
            >
              <option value="">None</option>
              {parentOptions.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.key} · {candidate.title}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          label="Labels"
          hint="Optional. Comma separated and applied to this project."
        >
          {(id) => (
            <>
              <input
                id={id}
                data-testid="new-issue-labels"
                value={labels}
                onChange={(event) => {
                  setLabels(event.target.value);
                }}
                className="field-input font-mono text-[11px]"
                placeholder="ui, api"
                list="new-issue-labels"
              />
              <datalist id="new-issue-labels">
                {allLabels.map((label) => (
                  <option key={label} value={label} />
                ))}
              </datalist>
            </>
          )}
        </Field>

        <RelationSelect
          label="Blocked by"
          hint="These issues must reach Done before this one is claimable."
          candidates={candidates}
          value={blockedBy}
          onChange={setBlockedBy}
          testId="new-issue-blocked-by"
        />
        <RelationSelect
          label="Blocks"
          hint="This issue must reach Done before these issues are claimable."
          candidates={candidates}
          value={blocks}
          onChange={setBlocks}
          testId="new-issue-blocks"
        />

        <div className="mt-1 flex items-center justify-between gap-3 border-t border-line pt-3.5">
          <span className="font-mono text-[9.5px] text-fg-muted">
            {project.key}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={submitting}
              data-testid="new-issue-submit"
            >
              Create issue
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
