import { WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Board } from "./components/Board.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { IssueDetail } from "./components/IssueDetail.tsx";
import { NewIssueDialog } from "./components/NewIssueDialog.tsx";
import type { NewIssueInput } from "./components/NewIssueDialog.tsx";
import { ProjectSetup } from "./components/ProjectSetup.tsx";
import { Queue } from "./components/Queue.tsx";
import {
  MobileNav,
  Sidebar,
  Topbar,
} from "./components/Shell.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { Toasts } from "./components/Toasts.tsx";
import type { ToastItem, ToastKind } from "./components/Toasts.tsx";
import { Button, LogoMark, Spinner } from "./components/ui.tsx";
import { api, ApiError } from "./lib/api.ts";
import { useIssueEvents } from "./lib/events.ts";
import { STATUS_LABEL } from "./lib/presentation.ts";
import {
  boardPath,
  issuePath,
  queuePath,
  useRoute,
} from "./lib/router.ts";
import type {
  Issue,
  IssueTimeline,
  Priority,
  Project,
  ReadyQueue,
  Status,
} from "./lib/types.ts";

type AuthState = "checking" | "anonymous" | "human" | "error";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return "Something went wrong. Try again.";
}

function BootScreen({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4">
      <LogoMark className="size-7 text-spice" />
      <div className="flex items-center gap-2 text-[11px] text-fg-muted">
        <Spinner className="size-3.5" />
        {label}
      </div>
    </div>
  );
}

function BootError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-ui border border-line bg-panel p-5">
        <WarningCircle className="size-5 text-storm" aria-hidden="true" />
        <h1 className="mt-3 text-[16px] font-semibold tracking-[-0.01em] text-fg">
          Cannot reach the server
        </h1>
        <p className="mt-1.5 text-[12px] leading-relaxed text-fg-secondary">
          {message}
        </p>
        <Button variant="secondary" size="md" className="mt-4" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export function App() {
  const { route, navigate } = useRoute();

  const [auth, setAuth] = useState<AuthState>("checking");
  const [bootError, setBootError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsTick, setProjectsTick] = useState(0);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [ready, setReady] = useState<ReadyQueue | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dataTick, setDataTick] = useState(0);

  const [timeline, setTimeline] = useState<IssueTimeline | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailTick, setDetailTick] = useState(0);

  const [query, setQuery] = useState("");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newIssue, setNewIssue] = useState<{ open: boolean; status: Status }>({
    open: false,
    status: "backlog",
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toastId = useRef(0);
  const loadedProjects = useRef(new Set<string>());

  const notify = useCallback((kind: ToastKind, message: string): void => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current.slice(-2), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

  const onUnauthorized = useCallback((): void => {
    setAuth("anonymous");
    setProjects([]);
    setProjectsLoaded(false);
    setIssues([]);
    setReady(null);
    setTimeline(null);
  }, []);

  const checkSession = useCallback(async (): Promise<void> => {
    setAuth("checking");
    setBootError(null);
    try {
      await api.me();
      setAuth("human");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuth("anonymous");
      } else {
        setBootError(messageOf(error));
        setAuth("error");
      }
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (auth !== "human") {
      return;
    }
    let alive = true;
    setProjectsLoaded(false);
    setProjectsError(null);
    void api
      .projects()
      .then((result) => {
        if (!alive) {
          return;
        }
        setProjects(result.projects);
        setProjectsLoaded(true);
      })
      .catch((error: unknown) => {
        if (!alive) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setProjectsError(messageOf(error));
        setProjectsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [auth, projectsTick, onUnauthorized]);

  const projectKeyFromRoute =
    route.project !== undefined &&
    projects.some((project) => project.key === route.project)
      ? route.project
      : projects[0]?.key ?? null;
  const project =
    projects.find((item) => item.key === projectKeyFromRoute) ?? null;

  useEffect(() => {
    if (auth !== "human" || projects.length === 0) {
      return;
    }
    if (
      route.project !== undefined &&
      projects.some((item) => item.key === route.project)
    ) {
      return;
    }
    const first = projects[0];
    if (first === undefined) {
      return;
    }
    navigate(
      route.kind === "queue" ? queuePath(first.key) : boardPath(first.key),
      { replace: true },
    );
  }, [auth, projects, route, navigate]);

  useEffect(() => {
    setQuery("");
    setLabelFilter(null);
    setPaletteOpen(false);
  }, [projectKeyFromRoute]);

  useEffect(() => {
    if (projectKeyFromRoute === null) {
      return;
    }
    loadedProjects.current.delete(projectKeyFromRoute);
    setIssues([]);
    setReady(null);
    setIssuesError(null);
    setTimeline(null);
    setIssuesLoading(true);
  }, [projectKeyFromRoute]);

  const refresh = useCallback((): void => {
    setDataTick((current) => current + 1);
  }, []);

  useEffect(() => {
    if (auth !== "human" || projectKeyFromRoute === null) {
      return;
    }
    let alive = true;
    const key = projectKeyFromRoute;

    async function load(background: boolean): Promise<void> {
      if (background) {
        setRefreshing(true);
      } else {
        setIssuesLoading(true);
      }
      try {
        const [issueResult, readyResult] = await Promise.all([
          api.issues(key),
          api.ready(key),
        ]);
        if (!alive) {
          return;
        }
        setIssues(issueResult.issues);
        setReady(readyResult);
        setIssuesError(null);
        loadedProjects.current.add(key);
      } catch (error) {
        if (!alive) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setIssuesError(messageOf(error));
      } finally {
        if (alive) {
          setIssuesLoading(false);
          setRefreshing(false);
        }
      }
    }

    void load(!loadedProjects.current.has(key));

    const onFocus = (): void => {
      void load(true);
    };
    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [auth, projectKeyFromRoute, dataTick, onUnauthorized]);

  const issueKey = route.kind === "issue" ? route.key : null;

  const onEventsChange = useCallback((): void => {
    refresh();
    if (issueKey !== null) {
      setDetailTick((current) => current + 1);
    }
  }, [issueKey, refresh]);

  useIssueEvents({
    enabled: auth === "human" && project !== null,
    projectId: project?.id ?? null,
    onChange: onEventsChange,
  });

  useEffect(() => {
    if (auth !== "human" || issueKey === null) {
      setTimeline(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let alive = true;
    setTimeline((current) => (current?.issue.key === issueKey ? current : null));
    setDetailLoading(true);
    setDetailError(null);
    void api
      .issue(issueKey)
      .then((result) => {
        if (!alive) {
          return;
        }
        setTimeline(result);
      })
      .catch((error: unknown) => {
        if (!alive) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setDetailError(messageOf(error));
      })
      .finally(() => {
        if (alive) {
          setDetailLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [auth, issueKey, detailTick, onUnauthorized]);

  const run = useCallback(
    async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
      try {
        await action();
        if (success !== undefined) {
          notify("success", success);
        }
        refresh();
        if (issueKey !== null) {
          setDetailTick((current) => current + 1);
        }
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
        }
        notify("error", messageOf(error));
        return false;
      }
    },
    [issueKey, notify, onUnauthorized, refresh],
  );

  const openIssue = useCallback(
    (issue: Issue): void => {
      navigate(issuePath(issue.projectKey, issue.key));
    },
    [navigate],
  );

  const openIssueKey = useCallback(
    (key: string): void => {
      const prefix = key.includes("-") ? key.slice(0, key.indexOf("-")) : project?.key;
      if (prefix === undefined) {
        return;
      }
      navigate(issuePath(prefix, key));
    },
    [navigate, project],
  );

  const openNewIssue = useCallback((status: Status = "backlog"): void => {
    setPaletteOpen(false);
    setNewIssue({ open: true, status });
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await api.signOut();
    } catch {
      // The session may already be gone; clear local state regardless.
    }
    onUnauthorized();
  }, [onUnauthorized]);

  const createIssue = useCallback(
    async (input: NewIssueInput): Promise<boolean> => {
      if (project === null) {
        return false;
      }
      try {
        const result = await api.createIssue({
          project: project.key,
          title: input.title,
          description: input.description,
          priority: input.priority,
          status: input.status,
        });
        if (input.labels.length > 0) {
          try {
            await api.setLabels(result.issue.key, input.labels);
          } catch (error) {
            notify(
              "error",
              `${result.issue.key} was created, but labels failed: ${messageOf(error)}`,
            );
          }
        }
        notify("success", `Created ${result.issue.key}`);
        refresh();
        setDetailTick((current) => current + 1);
        navigate(issuePath(project.key, result.issue.key));
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
        }
        notify("error", messageOf(error));
        return false;
      }
    },
    [navigate, notify, onUnauthorized, project, refresh],
  );

  const handleProjectCreated = useCallback(
    (created: Project): void => {
      setProjects((current) =>
        [...current.filter((item) => item.key !== created.key), created].sort(
          (left, right) => left.key.localeCompare(right.key),
        ),
      );
      setProjectsLoaded(true);
      navigate(boardPath(created.key));
      notify("success", `Created project ${created.key}`);
    },
    [navigate, notify],
  );

  const handleProjectChange = useCallback(
    (key: string): void => {
      navigate(boardPath(key));
      setQuery("");
      setLabelFilter(null);
    },
    [navigate],
  );

  const handleLabelFilter = useCallback(
    (label: string | null): void => {
      setLabelFilter(label);
      if (project !== null && route.kind === "queue") {
        navigate(boardPath(project.key));
      }
    },
    [navigate, project, route.kind],
  );

  const handleQueryChange = useCallback(
    (value: string): void => {
      setQuery(value);
      if (project !== null && route.kind === "queue" && value.length > 0) {
        navigate(boardPath(project.key));
      }
    },
    [navigate, project, route.kind],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (auth === "checking") {
    return <BootScreen />;
  }

  if (auth === "error") {
    return (
      <BootError
        message={bootError ?? "The server did not respond."}
        onRetry={() => {
          void checkSession();
        }}
      />
    );
  }

  if (auth === "anonymous") {
    return (
      <SignIn
        onAuthenticated={() => {
          setAuth("human");
        }}
      />
    );
  }

  if (!projectsLoaded) {
    return <BootScreen label="Loading projects" />;
  }

  if (projectsError !== null && projects.length === 0) {
    return (
      <BootError
        message={projectsError}
        onRetry={() => {
          setProjectsTick((current) => current + 1);
        }}
      />
    );
  }

  if (projects.length === 0) {
    return (
      <ProjectSetup
        onCreated={handleProjectCreated}
        onSignOut={() => {
          void signOut();
        }}
      />
    );
  }

  if (project === null) {
    return <BootScreen />;
  }

  const allLabels = [...new Set(issues.flatMap((issue) => issue.labels))].sort(
    (left, right) => left.localeCompare(right),
  );
  const issueKeys = issues.map((issue) => issue.key);

  return (
    <>
      <div className="fixed inset-0 flex h-[100dvh] overflow-hidden">
        <Sidebar
          projects={projects}
          project={project}
          route={route}
          issues={issues}
          readyCount={ready?.ready.length ?? 0}
          labelFilter={labelFilter}
          onLabelFilter={handleLabelFilter}
          onProjectChange={handleProjectChange}
          onNavigate={navigate}
          onSignOut={() => {
            void signOut();
          }}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            projects={projects}
            project={project}
            route={route}
            query={query}
            onQueryChange={handleQueryChange}
            onProjectChange={handleProjectChange}
            onNewIssue={() => {
              openNewIssue("backlog");
            }}
            onRefresh={() => {
              refresh();
            }}
            refreshing={refreshing}
          />

          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <main className="flex min-w-0 flex-1 flex-col">
              {issuesError !== null && issues.length > 0 ? (
                <div className="flex items-center gap-2 border-b border-storm/25 bg-storm/[0.07] px-4 py-1.5 text-[10.5px] text-storm">
                  <WarningCircle className="size-3.5 shrink-0" aria-hidden="true" />
                  Refresh failed: {issuesError}
                </div>
              ) : null}

              {issuesError !== null && issues.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-5">
                  <div className="w-full max-w-sm rounded-ui border border-line bg-panel p-4">
                    <WarningCircle className="size-4 text-storm" aria-hidden="true" />
                    <p className="mt-2 text-[12.5px] leading-relaxed text-fg-secondary">
                      {issuesError}
                    </p>
                    <Button
                      variant="secondary"
                      size="md"
                      className="mt-3"
                      onClick={refresh}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ) : route.kind === "queue" ? (
                <Queue
                  issues={issues}
                  ready={ready}
                  loading={issuesLoading}
                  onOpenIssue={openIssue}
                  onUnblock={async (key) => {
                    await run(
                      () => api.unblock(key),
                      `Unblocked ${key}`,
                    );
                  }}
                  onNewIssue={() => {
                    openNewIssue("todo");
                  }}
                />
              ) : (
                <Board
                  key={project.key}
                  issues={issues}
                  query={query}
                  labelFilter={labelFilter}
                  readyCount={ready?.ready.length ?? 0}
                  loading={issuesLoading}
                  onOpenIssue={openIssue}
                  onMove={(key, status) => {
                    void run(
                      () => api.transition(key, status),
                      `Moved ${key} to ${STATUS_LABEL[status]}`,
                    );
                  }}
                  onNewIssue={openNewIssue}
                  onClearFilters={() => {
                    setQuery("");
                    setLabelFilter(null);
                  }}
                  onOpenQueue={() => {
                    navigate(queuePath(project.key));
                  }}
                />
              )}
            </main>

            {issueKey !== null ? (
              <IssueDetail
                issueKey={issueKey}
                timeline={timeline}
                loading={detailLoading}
                error={detailError}
                allLabels={allLabels}
                issueKeys={issueKeys}
                onClose={() => {
                  navigate(boardPath(project.key));
                }}
                onOpenIssueKey={openIssueKey}
                onRetry={() => {
                  setDetailTick((current) => current + 1);
                }}
                onTransition={(key, status) =>
                  run(
                    () => api.transition(key, status),
                    `Moved ${key} to ${STATUS_LABEL[status]}`,
                  )
                }
                onComment={(key, body) =>
                  run(() => api.comment(key, body), "Comment added")
                }
                onUpdate={(
                  key,
                  fields: {
                    title?: string;
                    description?: string;
                    priority?: Priority;
                  },
                ) => run(() => api.updateIssue(key, fields), "Issue updated")}
                onSetLabels={(key, labels) =>
                  run(() => api.setLabels(key, labels), "Labels updated")
                }
                onAddRelation={(key, blocking) =>
                  run(
                    () => api.addRelation(key, blocking),
                    `Added ${blocking} as a blocker`,
                  )
                }
                onUnblock={(key) =>
                  run(() => api.unblock(key), `Unblocked ${key}`)
                }
              />
            ) : null}
          </div>

          <MobileNav
            route={route}
            readyCount={ready?.ready.length ?? 0}
            onNavigate={navigate}
            onNewIssue={() => {
              openNewIssue("backlog");
            }}
            onOpenPalette={() => {
              setPaletteOpen(true);
            }}
            projectKey={project.key}
          />
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
        issues={issues}
        projects={projects}
        project={project}
        onOpenIssue={(issue) => {
          openIssue(issue);
        }}
        onNavigate={navigate}
        onNewIssue={() => {
          openNewIssue("backlog");
        }}
        onSignOut={() => {
          void signOut();
        }}
        onRefresh={refresh}
      />

      <NewIssueDialog
        open={newIssue.open}
        project={project}
        defaultStatus={newIssue.status}
        allLabels={allLabels}
        onClose={() => {
          setNewIssue((current) => ({ ...current, open: false }));
        }}
        onCreate={createIssue}
      />

      <Toasts
        items={toasts}
        onDismiss={(id) => {
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }}
      />
    </>
  );
}
