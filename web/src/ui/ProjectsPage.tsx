import { Folder, Plus } from "@phosphor-icons/react";
import { useState } from "react";

import {
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_ORDER,
  projectProgressPercent,
} from "../domain/presentation.ts";
import type { Project } from "../domain/types.ts";
import { WorkspaceHeading } from "./Shell.tsx";
import { Button, EmptyState, ProjectStatusChip } from "./ui.tsx";

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((left, right) => {
    const priority = (left.priority ?? 5) - (right.priority ?? 5);
    return priority !== 0 ? priority : left.key.localeCompare(right.key);
  });
}

function ProjectCard({
  project,
  onOpen,
  onRestore,
}: {
  project: Project;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const archived = project.archivedAt !== null;
  const progress = projectProgressPercent(project.progress);
  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-ui border border-line bg-panel transition-colors hover:border-line-strong ${
        archived ? "opacity-80" : ""
      }`}
    >
      <button
        type="button"
        data-testid={`project-card-${project.key}`}
        onClick={onOpen}
        className="flex flex-1 flex-col p-3 text-left transition-colors hover:bg-elevated/40"
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-[9.5px] tracking-[0.08em] text-fg-muted">
            {project.key}
          </span>
          <ProjectStatusChip status={project.status} />
          {archived ? (
            <span className="ml-auto font-mono text-[9px] tracking-[0.08em] text-fg-muted uppercase">
              Archived
            </span>
          ) : null}
        </span>

        <span className="mt-2 block truncate text-[13px] font-medium text-fg">
          {project.name}
        </span>

        <span className="mt-1 block font-mono text-[9.5px] text-fg-muted">
          {project.targetDate === null
            ? "No target date"
            : `Target ${project.targetDate}`}
        </span>

        <span className="mt-2 block min-h-[2.4rem] text-[11.5px] leading-relaxed text-fg-secondary line-clamp-2">
          {project.summary.trim().length === 0 ? "No summary." : project.summary}
        </span>

        <span className="mt-3 flex items-center gap-2">
          <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-elevated">
            <span
              className="block h-full rounded-full bg-spice transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </span>
          <span className="shrink-0 font-mono text-[9.5px] text-fg-muted">
            {project.progress.done}/{project.progress.total} done
          </span>
        </span>
      </button>

      {archived ? (
        <div className="flex justify-end border-t border-line px-3 py-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onRestore}
            data-testid={`restore-project-${project.key}`}
          >
            Restore
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ProjectsPage({
  projects,
  onOpenProject,
  onNewProject,
  onRestore,
}: {
  projects: Project[];
  onOpenProject: (project: Project) => void;
  onNewProject: () => void;
  onRestore: (key: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = projects.filter(
    (project) => project.archivedAt !== null,
  ).length;
  const visible = projects.filter(
    (project) => showArchived || project.archivedAt === null,
  );

  const groups = PROJECT_STATUS_ORDER.map((status) => ({
    status,
    projects: sortProjects(visible.filter((project) => project.status === status)),
  })).filter((group) => group.projects.length > 0);

  return (
    <div
      data-testid="projects-page"
      className="scroll-area min-h-0 flex-1 overflow-y-auto pb-20 lg:pb-6"
    >
      <div className="px-4 py-4 sm:px-5">
        <WorkspaceHeading
          eyebrow="Projects"
          title="Projects"
          body="Group issues into outcomes and track their completion."
          actions={
            <Button
              variant="primary"
              size="md"
              data-testid="new-project"
              onClick={onNewProject}
              icon={<Plus className="size-3.5" weight="bold" aria-hidden="true" />}
            >
              New project
            </Button>
          }
        />

        {visible.length === 0 ? (
          <div className="mt-6 rounded-ui border border-line bg-panel">
            <EmptyState
              icon={<Folder className="size-5" aria-hidden="true" />}
              title={showArchived ? "No projects yet" : "No active projects"}
              body={
                showArchived
                  ? "Create a project to start grouping issues."
                  : "Create a project or show archived projects to see everything."
              }
              action={
                <Button variant="secondary" size="sm" onClick={onNewProject}>
                  New project
                </Button>
              }
            />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.status}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="font-mono text-[9.5px] tracking-[0.12em] text-fg-muted uppercase">
                    {PROJECT_STATUS_LABEL[group.status]}
                  </h2>
                  <span className="font-mono text-[9.5px] text-fg-muted">
                    {group.projects.length}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {group.projects.map((project) => (
                    <ProjectCard
                      key={project.key}
                      project={project}
                      onOpen={() => {
                        onOpenProject(project);
                      }}
                      onRestore={() => {
                        onRestore(project.key);
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {archivedCount > 0 ? (
          <div className="mt-6 flex justify-start">
            <Button
              variant="ghost"
              size="sm"
              data-testid="toggle-archived"
              aria-pressed={showArchived}
              onClick={() => {
                setShowArchived((current) => !current);
              }}
            >
              {showArchived
                ? "Hide archived"
                : `Show archived (${archivedCount})`}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
