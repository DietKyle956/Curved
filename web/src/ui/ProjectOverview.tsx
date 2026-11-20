import {
  Archive,
  Kanban,
  PencilSimple,
  Plus,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

import {
  STATUS_LABEL,
  STATUS_ORDER,
  absoluteTime,
  projectPriorityLabel,
  projectProgressPercent,
} from "../domain/presentation.ts";
import type { Project } from "../domain/types.ts";
import { WorkspaceHeading } from "./Shell.tsx";
import { Button, ProjectStatusChip, StatusChip } from "./ui.tsx";

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 border-t border-line pt-2">
      <dt className="font-mono text-[9px] tracking-[0.1em] text-fg-muted uppercase">
        {label}
      </dt>
      <dd className="mt-1 truncate text-[11.5px] text-fg-secondary">
        {children}
      </dd>
    </div>
  );
}

export function ProjectOverview({
  project,
  onOpenBoard,
  onNewIssue,
  onEdit,
  onArchive,
  onRestore,
}: {
  project: Project;
  onOpenBoard: () => void;
  onNewIssue: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const archived = project.archivedAt !== null;
  const percent = projectProgressPercent(project.progress);
  const byStatus = project.progress.byStatus;

  return (
    <div
      data-testid="project-overview"
      className="scroll-area min-h-0 flex-1 overflow-y-auto pb-20 lg:pb-6"
    >
      <div className="px-4 py-4 sm:px-5">
        <WorkspaceHeading
          eyebrow="Project"
          title={project.name}
          body={
            project.summary.trim().length === 0 ? "No summary yet." : project.summary
          }
          actions={
            <>
              <Button
                variant="primary"
                size="md"
                onClick={onNewIssue}
                icon={<Plus className="size-3.5" weight="bold" aria-hidden="true" />}
              >
                New issue
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={onOpenBoard}
                icon={<Kanban className="size-3.5" aria-hidden="true" />}
              >
                Open board
              </Button>
              <Button
                variant="secondary"
                size="md"
                data-testid="project-edit"
                onClick={onEdit}
                icon={<PencilSimple className="size-3.5" aria-hidden="true" />}
              >
                Edit
              </Button>
            </>
          }
        />

        {project.archivedAt === null ? null : (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-ui border border-ember/30 bg-ember/[0.08] px-3 py-2.5">
            <Archive className="size-3.5 shrink-0 text-ember" aria-hidden="true" />
            <p className="text-[11.5px] leading-relaxed text-ember">
              Archived {absoluteTime(project.archivedAt)}. This project is
              read-only until it is restored.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              data-testid="project-restore"
              onClick={onRestore}
            >
              Restore
            </Button>
          </div>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetaItem label="Key">
            <span className="font-mono text-[10.5px]">{project.key}</span>
          </MetaItem>
          <MetaItem label="Status">
            <ProjectStatusChip status={project.status} />
          </MetaItem>
          <MetaItem label="Priority">{projectPriorityLabel(project.priority)}</MetaItem>
          <MetaItem label="Start">
            <span className="font-mono text-[10.5px]">
              {project.startDate ?? "None"}
            </span>
          </MetaItem>
          <MetaItem label="Target">
            <span className="font-mono text-[10.5px]">
              {project.targetDate ?? "None"}
            </span>
          </MetaItem>
          <MetaItem label="Updated">{absoluteTime(project.updatedAt)}</MetaItem>
        </dl>

        <p className="mt-2 font-mono text-[9.5px] text-fg-muted">
          Created {absoluteTime(project.createdAt)}
        </p>

        <div
          data-testid="project-progress"
          className="mt-6 rounded-ui border border-line bg-panel p-4"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[9.5px] tracking-[0.12em] text-fg-muted uppercase">
                Progress
              </p>
              <p className="mt-1 font-mono text-[28px] leading-none text-fg">
                {percent}%
              </p>
            </div>
            <p className="font-mono text-[10px] text-fg-secondary">
              {project.progress.done}/{project.progress.total} done
            </p>
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full bg-spice transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {STATUS_ORDER.map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <StatusChip status={status} />
                <span
                  className="font-mono text-[10px] text-fg-muted"
                  aria-label={`${STATUS_LABEL[status]}: ${byStatus[status]}`}
                >
                  {byStatus[status]}
                </span>
              </span>
            ))}
          </div>
        </div>

        <section className="mt-6 min-w-0">
          <h2 className="text-[12px] font-medium text-fg">Description</h2>
          <p
            className={`mt-2 max-w-[80ch] text-[12px] leading-relaxed break-words whitespace-pre-wrap ${
              project.description.trim().length === 0
                ? "text-fg-muted"
                : "text-fg-secondary"
            }`}
          >
            {project.description.trim().length === 0
              ? "No description yet."
              : project.description}
          </p>
        </section>

        {archived ? null : (
          <section className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <p className="text-[10.5px] leading-relaxed text-fg-muted">
              Archive hides the project from the default list. Nothing is
              deleted.
            </p>
            <Button
              variant="danger"
              size="sm"
              className="ml-auto"
              onClick={onArchive}
              data-testid="project-archive"
              icon={<Archive className="size-3.5" aria-hidden="true" />}
            >
              Archive
            </Button>
          </section>
        )}
      </div>
    </div>
  );
}
