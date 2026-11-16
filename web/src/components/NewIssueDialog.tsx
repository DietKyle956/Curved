import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { PRIORITY_LABEL, STATUS_LABEL } from "../lib/presentation.ts";
import type { Priority, Project, Status } from "../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import { Button, Field } from "./ui.tsx";

export interface NewIssueInput {
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  labels: string[];
}

export function NewIssueDialog({
  open,
  project,
  defaultStatus,
  allLabels,
  onClose,
  onCreate,
}: {
  open: boolean;
  project: Project;
  defaultStatus: Status;
  allLabels: string[];
  onClose: () => void;
  onCreate: (input: NewIssueInput) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>(3);
  const [status, setStatus] = useState<Status>("backlog");
  const [labels, setLabels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle("");
    setDescription("");
    setPriority(3);
    setStatus(defaultStatus === "todo" ? "todo" : "backlog");
    setLabels("");
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
      labels: labels
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label.length > 0),
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
          label="Labels"
          hint="Optional. Comma separated and applied to this project."
        >
          {(id) => (
            <>
              <input
                id={id}
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

        <div className="mt-1 flex items-center justify-between gap-3 border-t border-line pt-3.5">
          <span className="font-mono text-[9.5px] text-fg-muted">
            {project.key}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" loading={submitting}>
              Create issue
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
