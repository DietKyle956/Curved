import {
  ArrowsClockwise,
  ArrowRight,
  Folder,
  Key,
  ListChecks,
  MagnifyingGlass,
  Plus,
  SignOut,
  SquaresFour,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { matchesQuery } from "../domain/presentation.ts";
import {
  boardPath,
  overviewPath,
  projectsPath,
  queuePath,
} from "../domain/routes.ts";
import type { Issue, Project } from "../domain/types.ts";
import { Kbd, PriorityMark, StatusChip } from "./ui.tsx";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

interface PaletteItem {
  id: string;
  group: "Actions" | "Issues" | "Projects";
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  issues: Issue[];
  projects: Project[];
  project: Project;
  onOpenIssue: (issue: Issue) => void;
  onNavigate: (path: string) => void;
  onNewIssue: () => void;
  onNewProject: () => void;
  onOpenPasskeys: () => void;
  onSignOut: () => void;
  onRefresh: () => void;
}

export function CommandPalette({
  open,
  onClose,
  issues,
  projects,
  project,
  onOpenIssue,
  onNavigate,
  onNewIssue,
  onNewProject,
  onOpenPasskeys,
  onSignOut,
  onRefresh,
}: CommandPaletteProps) {
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      const frame = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }
  }, [open]);

  const actions: PaletteItem[] = [
    {
      id: "new-issue",
      group: "Actions",
      label: "New issue",
      hint: "create",
      icon: <Plus className="size-4" aria-hidden="true" />,
      run: onNewIssue,
    },
    {
      id: "new-project",
      group: "Actions",
      label: "New project",
      hint: "create",
      icon: <Plus className="size-4" aria-hidden="true" />,
      run: onNewProject,
    },
    {
      id: "projects",
      group: "Actions",
      label: "Go to projects",
      hint: projectsPath(),
      icon: <Folder className="size-4" aria-hidden="true" />,
      run: () => {
        onNavigate(projectsPath());
      },
    },
    {
      id: "board",
      group: "Actions",
      label: "Go to board",
      hint: boardPath(project.key),
      icon: <SquaresFour className="size-4" aria-hidden="true" />,
      run: () => {
        onNavigate(boardPath(project.key));
      },
    },
    {
      id: "queue",
      group: "Actions",
      label: "Go to ready queue",
      hint: queuePath(project.key),
      icon: <ListChecks className="size-4" aria-hidden="true" />,
      run: () => {
        onNavigate(queuePath(project.key));
      },
    },
    {
      id: "refresh",
      group: "Actions",
      label: "Refresh data",
      hint: "reload",
      icon: <ArrowsClockwise className="size-4" aria-hidden="true" />,
      run: onRefresh,
    },
    {
      id: "passkeys",
      group: "Actions",
      label: "Manage passkeys",
      hint: "security",
      icon: <Key className="size-4" aria-hidden="true" />,
      run: onOpenPasskeys,
    },
    {
      id: "sign-out",
      group: "Actions",
      label: "Sign out",
      hint: "session",
      icon: <SignOut className="size-4" aria-hidden="true" />,
      run: onSignOut,
    },
    ...projects.map<PaletteItem>((item) => ({
      id: `project-${item.key}`,
      group: "Projects",
      label: `Open ${item.name}`,
      hint: item.key,
      icon: <Folder className="size-4" aria-hidden="true" />,
      run: () => {
        onNavigate(overviewPath(item.key));
      },
    })),
  ];

  const needle = query.trim().toLowerCase();
  const visibleActions = actions.filter(
    (item) =>
      needle.length === 0 ||
      item.label.toLowerCase().includes(needle) ||
      (item.hint ?? "").toLowerCase().includes(needle),
  );
  const visibleIssues = issues
    .filter((issue) => matchesQuery(issue, query))
    .slice(0, 50)
    .map<PaletteItem>((issue) => ({
      id: `issue-${issue.key}`,
      group: "Issues",
      label: issue.title,
      hint: issue.key,
      icon: <ArrowRight className="size-3.5" aria-hidden="true" />,
      run: () => {
        onOpenIssue(issue);
      },
    }));

  const results = [...visibleActions, ...visibleIssues];
  const activeItem = results[active];

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setActive((current) =>
      results.length === 0 ? 0 : Math.min(current, results.length - 1),
    );
  }, [open, results.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || list === null) {
      return;
    }
    const option = list.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [open, active, query]);

  function runActive(): void {
    if (activeItem === undefined) {
      return;
    }
    activeItem.run();
    onClose();
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/75 px-3 pt-[12vh] backdrop-blur-[2px] sm:px-4"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.14 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onClose();
            }
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="flex max-h-[calc(100dvh-12vh-1rem)] w-full max-w-xl flex-col overflow-hidden rounded-ui border border-line bg-panel shadow-float"
            initial={reduce ? false : { opacity: 0, y: -6, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: -4, scale: 0.995 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={(event) => {
              if (event.key === "Tab" && panelRef.current !== null) {
                const focusable = Array.from(
                  panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
                ).filter((element) => element.offsetParent !== null);
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (first !== undefined && last !== undefined) {
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                  }
                }
                return;
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) =>
                  results.length === 0 ? 0 : (current + 1) % results.length,
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) =>
                  results.length === 0
                    ? 0
                    : (current - 1 + results.length) % results.length,
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                runActive();
              }
            }}
          >
            <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-3.5">
              <MagnifyingGlass
                className="size-4 shrink-0 text-fg-muted"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="Search issues or run a command"
                aria-label="Search issues or run a command"
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-results"
                aria-activedescendant={
                  activeItem === undefined ? undefined : `palette-${activeItem.id}`
                }
                className="h-12 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-muted"
              />
              <Kbd>esc</Kbd>
            </div>

            <div
              ref={listRef}
              id="palette-results"
              role="listbox"
              aria-label="Results"
              className="scroll-area min-h-0 flex-1 overflow-y-auto py-1.5 scroll-pb-1.5"
            >
              {results.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-[12px] text-fg-secondary">No matches</p>
                  <p className="mt-1 text-[11px] text-fg-muted">
                    Try an issue key, a title, or a label.
                  </p>
                </div>
              ) : (
                results.map((item, index) => {
                  const previous = results[index - 1];
                  const showGroup = previous === undefined || previous.group !== item.group;
                  return (
                    <div key={item.id}>
                      {showGroup ? (
                        <p className="px-3.5 pt-2 pb-1 font-mono text-[9px] tracking-[0.12em] text-fg-muted uppercase">
                          {item.group}
                        </p>
                      ) : null}
                      <button
                        id={`palette-${item.id}`}
                        type="button"
                        role="option"
                        aria-selected={index === active}
                        onMouseMove={() => {
                          setActive(index);
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          item.run();
                          onClose();
                        }}
                        className={`mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-2.5 rounded-ui px-2.5 py-2 text-left transition-colors ${
                          index === active ? "bg-elevated" : ""
                        }`}
                      >
                        <span
                          className={
                            index === active ? "text-spice" : "text-fg-muted"
                          }
                        >
                          {item.icon}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                          {item.label}
                        </span>
                        {item.group === "Issues" ? (
                          <>
                            <span
                              data-testid="palette-key"
                              className="shrink-0 font-mono text-[9.5px] text-fg-secondary"
                            >
                              {item.hint}
                            </span>
                            <IssueBadge
                              keyName={item.hint ?? ""}
                              issues={issues}
                            />
                          </>
                        ) : item.hint !== undefined ? (
                          <span className="max-w-[10rem] truncate font-mono text-[9.5px] text-fg-secondary">
                            {item.hint}
                          </span>
                        ) : null}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-fg-muted">
              <span className="inline-flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                navigate
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>↵</Kbd>
                open
              </span>
              <span className="ml-auto font-mono text-[9px]">
                {results.length} result{results.length === 1 ? "" : "s"}
              </span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function IssueBadge({ keyName, issues }: { keyName: string; issues: Issue[] }) {
  const issue = issues.find((item) => item.key === keyName);
  if (issue === undefined) {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <PriorityMark priority={issue.priority} />
      <StatusChip status={issue.status} />
    </span>
  );
}
