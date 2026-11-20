import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { isApplicationError } from "../application/errors.ts";
import {
  PRIORITY_LABEL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_ORDER,
} from "../domain/presentation.ts";
import type {
  NewProjectInput,
  Priority,
  Project,
  ProjectStatus,
} from "../domain/types.ts";
import { Dialog } from "./Dialog.tsx";
import { Button, Field } from "./ui.tsx";

const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

function isDateValue(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export function ProjectDialog({
  open,
  project,
  onClose,
  onSave,
}: {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSave: (input: NewProjectInput) => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("planned");
  const [priority, setPriority] = useState<Priority | "">("");
  const [startDate, setStartDate] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setKey(project?.key ?? "");
    setName(project?.name ?? "");
    setSummary(project?.summary ?? "");
    setDescription(project?.description ?? "");
    setStatus(project?.status ?? "planned");
    setPriority(project?.priority ?? "");
    setStartDate(project?.startDate ?? "");
    setTargetDate(project?.targetDate ?? "");
    setError(null);
    setSaving(false);
  }, [open, project]);

  const editing = project !== null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedKey = key.trim().toUpperCase();
    if (!editing && !KEY_PATTERN.test(normalizedKey)) {
      setError("Project key must be 2 to 10 characters, starting with a letter.");
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Give the project a name.");
      return;
    }
    if (startDate.length > 0 && !isDateValue(startDate)) {
      setError("Start date must be a valid date.");
      return;
    }
    if (targetDate.length > 0 && !isDateValue(targetDate)) {
      setError("Target date must be a valid date.");
      return;
    }
    setSaving(true);
    setError(null);
    let ok = false;
    try {
      ok = await onSave({
        key: project !== null ? project.key : normalizedKey,
        name: trimmedName,
        summary: summary.trim(),
        description,
        status,
        priority: priority === "" ? null : priority,
        startDate: startDate.length === 0 ? null : startDate,
        targetDate: targetDate.length === 0 ? null : targetDate,
      });
    } catch (caught) {
      setSaving(false);
      setError(
        isApplicationError(caught)
          ? caught.message
          : "Could not save the project.",
      );
      return;
    }
    setSaving(false);
    if (ok) {
      onClose();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project !== null ? `Edit ${project.key}` : "New project"}
      description={
        project !== null
          ? "Update the project details. The key does not change."
          : "The key becomes the prefix for every issue in the project."
      }
      size="md"
    >
      <form
        data-testid="project-dialog"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3.5"
      >
        {editing ? null : (
          <Field
            label="Project key"
            hint="Uppercase letters and digits. 2 to 10 characters."
          >
            {(id) => (
              <input
                id={id}
                data-testid="project-key"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value.toUpperCase());
                  setError(null);
                }}
                className="field-input font-mono tracking-[0.08em] uppercase"
                placeholder="CRV"
                maxLength={10}
                autoFocus
              />
            )}
          </Field>
        )}

        <Field label="Name">
          {(id) => (
            <input
              id={id}
              data-testid="project-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              className="field-input"
              placeholder="Curved"
              maxLength={200}
              autoFocus={editing}
            />
          )}
        </Field>

        <Field label="Summary" hint="One line shown on project cards.">
          {(id) => (
            <input
              id={id}
              data-testid="project-summary"
              value={summary}
              onChange={(event) => {
                setSummary(event.target.value);
              }}
              className="field-input"
              placeholder="What is this project working toward?"
              maxLength={255}
            />
          )}
        </Field>

        <Field label="Description">
          {(id) => (
            <textarea
              id={id}
              data-testid="project-description"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              className="field-input min-h-24 resize-y leading-relaxed"
              placeholder="Scope, context, and constraints."
              maxLength={20000}
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            {(id) => (
              <select
                id={id}
                data-testid="project-status"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as ProjectStatus);
                }}
                className="field-input"
              >
                {PROJECT_STATUS_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {PROJECT_STATUS_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Priority">
            {(id) => (
              <select
                id={id}
                data-testid="project-priority"
                value={priority === "" ? "" : String(priority)}
                onChange={(event) => {
                  setPriority(
                    event.target.value === ""
                      ? ""
                      : (Number(event.target.value) as Priority),
                  );
                }}
                className="field-input"
              >
                <option value="">No priority</option>
                {([1, 2, 3, 4] as const).map((value) => (
                  <option key={value} value={value}>
                    P{value} · {PRIORITY_LABEL[value]}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Start date">
            {(id) => (
              <input
                id={id}
                data-testid="project-start"
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                }}
                className="field-input"
              />
            )}
          </Field>

          <Field label="Target date">
            {(id) => (
              <input
                id={id}
                data-testid="project-target"
                type="date"
                value={targetDate}
                onChange={(event) => {
                  setTargetDate(event.target.value);
                }}
                className="field-input"
              />
            )}
          </Field>
        </div>

        {error !== null ? (
          <p className="rounded-ui border border-storm/35 bg-storm/10 px-3 py-2 text-[11.5px] leading-snug text-storm">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={saving}
            data-testid="project-save"
          >
            {editing ? "Save project" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
