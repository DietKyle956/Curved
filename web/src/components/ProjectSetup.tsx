import { SignOut } from "@phosphor-icons/react";
import { useState } from "react";
import type { FormEvent } from "react";

import { api, ApiError } from "../lib/api.ts";
import type { Project } from "../lib/types.ts";
import { Button, Field, LogoMark } from "./ui.tsx";

export function ProjectSetup({
  onCreated,
  onSignOut,
}: {
  onCreated: (project: Project) => void;
  onSignOut: () => void;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedKey = key.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(normalizedKey)) {
      setError("Project key must be 2 to 10 characters, starting with a letter.");
      return;
    }
    if (name.trim().length === 0) {
      setError("Give the project a name.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.createProject({
        key: normalizedKey,
        name: name.trim(),
      });
      onCreated(result.project);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not create the project.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 pt-[calc(1rem+env(safe-area-inset-top))] pb-4 sm:px-8">
        <div className="flex items-center gap-2.5">
          <LogoMark className="size-5 text-spice" />
          <span className="text-[14px] font-semibold tracking-[-0.02em]">Curved</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<SignOut className="size-3.5" aria-hidden="true" />}
          onClick={onSignOut}
        >
          Sign out
        </Button>
      </header>

      <div className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-md">
          <p className="font-mono text-[10px] tracking-[0.12em] text-fg-muted uppercase">
            Setup
          </p>
          <h1 className="mt-3 text-[26px] leading-tight font-semibold tracking-[-0.03em] text-fg">
            Create the first project
          </h1>
          <p className="mt-2 max-w-[46ch] text-[12.5px] leading-relaxed text-fg-secondary">
            Issue keys are allocated per project, in order. The key becomes the
            prefix: for example <span className="font-mono text-fg">CRV-14</span>.
          </p>

          <form
            onSubmit={(event) => void onSubmit(event)}
            className="mt-8 flex flex-col gap-4 rounded-ui border border-line bg-panel p-4 sm:p-5"
          >
            <Field label="Project key" hint="Uppercase letters and digits. 2 to 10 characters.">
              {(id) => (
                <input
                  id={id}
                  name="project-key"
                  autoFocus
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value.toUpperCase());
                    setError(null);
                  }}
                  className="field-input font-mono tracking-[0.08em] uppercase"
                  placeholder="CRV"
                  maxLength={10}
                />
              )}
            </Field>

            <Field label="Project name">
              {(id) => (
                <input
                  id={id}
                  name="project-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                  className="field-input"
                  placeholder="Curved"
                  maxLength={200}
                />
              )}
            </Field>

            {error !== null ? (
              <p className="rounded-ui border border-storm/35 bg-storm/10 px-3 py-2 text-[11.5px] leading-snug text-storm">
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" size="lg" loading={submitting}>
              {submitting ? "Creating project" : "Create project"}
            </Button>
          </form>

          <p className="mt-4 text-[11px] leading-relaxed text-fg-muted">
            You can create more projects later from the CLI. The web client works
            inside the selected project.
          </p>
        </div>
      </div>
    </main>
  );
}
