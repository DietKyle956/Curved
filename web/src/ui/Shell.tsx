import {
  ArrowsClockwise,
  CaretDown,
  Kanban,
  Key,
  ListChecks,
  MagnifyingGlass,
  Plus,
  SignOut,
  SquaresFour,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { STATUS_ORDER } from "../domain/presentation.ts";
import { boardPath, queuePath } from "../domain/routes.ts";
import type { Route } from "../domain/routes.ts";
import type { Issue, Project } from "../domain/types.ts";
import { AgentMark, Button, IconButton, Kbd, LogoMark } from "./ui.tsx";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? "⌘K" : "Ctrl K";

function sectionLabel(route: Route): string {
  if (route.kind === "queue") {
    return "Ready queue";
  }
  if (route.kind === "issue") {
    return route.key;
  }
  return "Board";
}

function ProjectSelect({
  projects,
  project,
  onChange,
}: {
  projects: Project[];
  project: Project;
  onChange: (key: string) => void;
}) {
  return (
    <div className="relative min-w-0">
      <select
        aria-label="Project"
        value={project.key}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full appearance-none rounded-ui border border-line bg-panel py-1.5 pr-8 pl-2.5 text-[12px] text-fg transition-colors hover:border-line-strong focus-visible:border-spice"
      >
        {projects.map((item) => (
          <option key={item.key} value={item.key}>
            {item.key} · {item.name}
          </option>
        ))}
      </select>
      <CaretDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 text-fg-muted"
        aria-hidden="true"
      />
    </div>
  );
}

interface NavRowProps {
  active: boolean;
  label: string;
  count?: number;
  icon: ReactNode;
  onClick: () => void;
}

function NavRow({ active, label, count, icon, onClick }: NavRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-ui px-2 py-2 text-[12px] transition-colors duration-150 ${
        active
          ? "bg-elevated text-fg"
          : "text-fg-secondary hover:bg-elevated/60 hover:text-fg"
      }`}
    >
      <span className={active ? "text-spice" : "text-fg-muted"}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined && count > 0 ? (
        <span className="font-mono text-[10px] text-fg-secondary">{count}</span>
      ) : null}
    </button>
  );
}

export function Sidebar({
  projects,
  project,
  route,
  issues,
  readyCount,
  labelFilter,
  onLabelFilter,
  onProjectChange,
  onNavigate,
  onOpenPasskeys,
  onSignOut,
}: {
  projects: Project[];
  project: Project;
  route: Route;
  issues: Issue[];
  readyCount: number;
  labelFilter: string | null;
  onLabelFilter: (label: string | null) => void;
  onProjectChange: (key: string) => void;
  onNavigate: (path: string) => void;
  onOpenPasskeys: () => void;
  onSignOut: () => void;
}) {
  const labels = new Map<string, number>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
  }
  const labelRows = [...labels.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  const activeAgents = new Map<string, string[]>();
  for (const issue of issues) {
    if (
      issue.claimedBy !== null &&
      (issue.status === "in_progress" || issue.status === "in_review")
    ) {
      const keys = activeAgents.get(issue.claimedBy) ?? [];
      keys.push(issue.key);
      activeAgents.set(issue.claimedBy, keys);
    }
  }

  return (
    <aside className="hidden w-[236px] shrink-0 flex-col border-r border-line lg:flex">
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-b border-line px-4">
        <LogoMark className="size-5 text-spice" />
        <span className="text-[14px] font-semibold tracking-[-0.02em] text-fg">
          Curved
        </span>
      </div>

      <div className="border-b border-line p-3">
        <ProjectSelect
          projects={projects}
          project={project}
          onChange={onProjectChange}
        />
      </div>

      <nav className="flex flex-col gap-0.5 p-2" aria-label="Workspace">
        <NavRow
          active={route.kind === "board" || route.kind === "issue"}
          label="Board"
          icon={<SquaresFour className="size-4" aria-hidden="true" />}
          onClick={() => {
            onNavigate(boardPath(project.key));
          }}
        />
        <NavRow
          active={route.kind === "queue"}
          label="Ready queue"
          count={readyCount}
          icon={<ListChecks className="size-4" aria-hidden="true" />}
          onClick={() => {
            onNavigate(queuePath(project.key));
          }}
        />
      </nav>

      <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <section className="mt-3">
          <h2 className="px-2 pb-1.5 font-mono text-[9.5px] tracking-[0.12em] text-fg-muted uppercase">
            Labels
          </h2>
          <button
            type="button"
            onClick={() => {
              onLabelFilter(null);
            }}
            aria-pressed={labelFilter === null}
            className={`flex w-full items-center justify-between rounded-ui px-2 py-1.5 text-left text-[11.5px] transition-colors ${
              labelFilter === null
                ? "bg-elevated text-fg"
                : "text-fg-secondary hover:bg-elevated/60 hover:text-fg"
            }`}
          >
            All labels
            <span className="font-mono text-[10px] text-fg-secondary">
              {issues.length}
            </span>
          </button>
          {labelRows.map(([label, count]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                onLabelFilter(labelFilter === label ? null : label);
              }}
              aria-pressed={labelFilter === label}
              className={`flex w-full items-center justify-between rounded-ui px-2 py-1.5 text-left text-[11.5px] transition-colors ${
                labelFilter === label
                  ? "bg-elevated text-fg"
                  : "text-fg-secondary hover:bg-elevated/60 hover:text-fg"
              }`}
            >
              <span className="truncate">{label}</span>
              <span className="font-mono text-[10px] text-fg-secondary">{count}</span>
            </button>
          ))}
          {labelRows.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-fg-muted">No labels yet.</p>
          ) : null}
        </section>

        <section className="mt-5">
          <h2 className="px-2 pb-1.5 font-mono text-[9.5px] tracking-[0.12em] text-fg-muted uppercase">
            Active agents
          </h2>
          {activeAgents.size === 0 ? (
            <p className="px-2 py-1.5 text-[11px] leading-relaxed text-fg-muted">
              No claims in flight.
            </p>
          ) : (
            [...activeAgents.entries()].map(([name, keys]) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-ui px-2 py-1.5"
              >
                <AgentMark name={name} active />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-secondary">
                  {name}
                </span>
                <span className="font-mono text-[10px] text-fg-muted">
                  {keys.join(" ")}
                </span>
              </div>
            ))
          )}
        </section>

        <section className="mt-5">
          <h2 className="px-2 pb-1.5 font-mono text-[9.5px] tracking-[0.12em] text-fg-muted uppercase">
            Workflow
          </h2>
          <ol className="space-y-1 px-2 py-1">
            {STATUS_ORDER.map((status) => (
              <li
                key={status}
                className="flex items-center justify-between font-mono text-[10px] text-fg-muted"
              >
                <span>{status}</span>
                <span>{issues.filter((issue) => issue.status === status).length}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-ui border border-line bg-elevated font-mono text-[9px] text-fg-secondary">
            H
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] leading-tight text-fg">Human session</p>
            <p className="mt-0.5 text-[10px] leading-tight text-fg-muted">
              Full workflow access
            </p>
          </div>
          <IconButton
            label="Passkeys"
            onClick={onOpenPasskeys}
            icon={<Key className="size-4" />}
          />
          <IconButton
            label="Sign out"
            onClick={onSignOut}
            icon={<SignOut className="size-4" />}
          />
        </div>
      </div>
    </aside>
  );
}

export function Topbar({
  projects,
  project,
  route,
  query,
  onQueryChange,
  onProjectChange,
  onNewIssue,
  onOpenPasskeys,
  onRefresh,
  refreshing,
}: {
  projects: Project[];
  project: Project;
  route: Route;
  query: string;
  onQueryChange: (value: string) => void;
  onProjectChange: (key: string) => void;
  onNewIssue: () => void;
  onOpenPasskeys: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="flex min-h-[60px] shrink-0 items-center gap-3 border-b border-line px-3 pt-[env(safe-area-inset-top)] sm:px-4 lg:px-5">
      <div className="flex min-w-0 items-center gap-2 lg:hidden">
        <LogoMark className="size-5 shrink-0 text-spice" />
        <div className="w-[8.5rem] min-w-0 sm:w-[12rem]">
          <ProjectSelect
            projects={projects}
            project={project}
            onChange={onProjectChange}
          />
        </div>
      </div>

      <div className="hidden min-w-0 items-center gap-2 lg:flex">
        <span className="truncate text-[12px] text-fg-secondary">{project.name}</span>
        <span className="text-[11px] text-line-strong">/</span>
        <span className="font-mono text-[11px] text-fg">{sectionLabel(route)}</span>
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <IconButton
          label="Passkeys"
          data-testid="open-passkeys"
          onClick={onOpenPasskeys}
          icon={<Key className="size-4" />}
        />
        <div className="relative hidden w-[15rem] md:block xl:w-[20rem]">
          <MagnifyingGlass
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            placeholder="Search issues"
            aria-label="Search issues"
            className="field-input h-8 py-0 pr-14 pl-8 text-[12px]"
          />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
            <Kbd>{SHORTCUT}</Kbd>
          </span>
        </div>

        <IconButton
          label="Refresh issues"
          onClick={onRefresh}
          icon={
            <ArrowsClockwise
              className={`size-4 ${refreshing ? "animate-spin" : ""}`}
            />
          }
        />
        <Button
          variant="primary"
          size="sm"
          onClick={onNewIssue}
          icon={<Plus className="size-3.5" weight="bold" aria-hidden="true" />}
          className="max-sm:hidden"
        >
          New issue
        </Button>
      </div>
    </header>
  );
}

export function MobileNav({
  route,
  readyCount,
  onNavigate,
  onNewIssue,
  onOpenPalette,
  projectKey,
}: {
  route: Route;
  readyCount: number;
  onNavigate: (path: string) => void;
  onNewIssue: () => void;
  onOpenPalette: () => void;
  projectKey: string;
}) {
  const boardActive = route.kind === "board" || route.kind === "issue";
  const queueActive = route.kind === "queue";
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm lg:hidden"
    >
      <div className="grid h-14 grid-cols-4">
        <button
          type="button"
          onClick={() => {
            onNavigate(boardPath(projectKey));
          }}
          aria-current={boardActive ? "page" : undefined}
          className={`flex flex-col items-center justify-center gap-1 text-[9.5px] transition-colors ${
            boardActive ? "text-spice" : "text-fg-muted hover:text-fg"
          }`}
        >
          <Kanban className="size-[18px]" aria-hidden="true" />
          Board
        </button>
        <button
          type="button"
          onClick={() => {
            onNavigate(queuePath(projectKey));
          }}
          aria-current={queueActive ? "page" : undefined}
          className={`relative flex flex-col items-center justify-center gap-1 text-[9.5px] transition-colors ${
            queueActive ? "text-spice" : "text-fg-muted hover:text-fg"
          }`}
        >
          <ListChecks className="size-[18px]" aria-hidden="true" />
          Queue
          {readyCount > 0 ? (
            <span className="absolute top-1.5 right-[calc(50%-1.15rem)] min-w-4 rounded-ui border border-canvas bg-spice px-1 text-center font-mono text-[8px] leading-4 text-canvas">
              {readyCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={onNewIssue}
          className="flex flex-col items-center justify-center gap-1 text-[9.5px] text-spice transition-colors hover:text-spice/80"
        >
          <Plus className="size-[18px]" weight="bold" aria-hidden="true" />
          New
        </button>
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex flex-col items-center justify-center gap-1 text-[9.5px] text-fg-muted transition-colors hover:text-fg"
        >
          <MagnifyingGlass className="size-[18px]" aria-hidden="true" />
          Search
        </button>
      </div>
    </nav>
  );
}

export function WorkspaceHeading({
  eyebrow,
  title,
  body,
  actions,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow !== undefined ? (
          <p className="font-mono text-[9.5px] tracking-[0.12em] text-fg-muted uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mt-1 text-[19px] leading-tight font-semibold tracking-[-0.02em] text-fg">
          {title}
        </h1>
        {body !== undefined ? (
          <p className="mt-1.5 max-w-[62ch] text-[12px] leading-relaxed text-fg-secondary">
            {body}
          </p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
