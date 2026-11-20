// Workspace orchestration: auth and session state, project selection, issue,
// ready-queue, and timeline loading, refresh and tick handling, and action
// execution with error mapping. The hook below is implemented in this module;
// the interface is the contract the ui layer consumes.

import { useCallback, useEffect, useRef, useState } from "react";

import { isUnauthorized, messageOf, passkeyErrorMessage } from "./errors.ts";
import type {
  NavigationPort,
  PasskeyPort,
  RealtimePort,
  ApiPort,
} from "./ports.ts";
import { STATUS_LABEL } from "../domain/presentation.ts";
import {
  boardPath,
  issuePath,
  newIssuePath,
  overviewPath,
  parseRoute,
  projectsPath,
  queuePath,
} from "../domain/routes.ts";
import type { Route } from "../domain/routes.ts";
import type {
  Issue,
  IssueTimeline,
  NewIssueInput,
  NewProjectInput,
  PasskeySummary,
  Priority,
  Project,
  ProjectPatch,
  ReadyQueue,
  Status,
  ToastItem,
  ToastKind,
} from "../domain/types.ts";

export type AuthState = "checking" | "anonymous" | "human" | "error";

export interface WorkspaceDeps {
  api: ApiPort;
  realtime: RealtimePort;
  navigation: NavigationPort;
  passkeys: PasskeyPort;
}

export interface Workspace {
  auth: AuthState;
  bootError: string | null;
  projects: Project[];
  projectsLoaded: boolean;
  projectsError: string | null;
  project: Project | null;
  issues: Issue[];
  ready: ReadyQueue | null;
  issuesLoading: boolean;
  issuesError: string | null;
  refreshing: boolean;
  timeline: IssueTimeline | null;
  detailLoading: boolean;
  detailError: string | null;
  query: string;
  labelFilter: string | null;
  paletteOpen: boolean;
  newIssueStatus: Status;
  toasts: ToastItem[];
  route: Route;
  issueKey: string | null;
  allLabels: string[];
  issueKeys: string[];

  passkeysSupported: boolean;
  passkeyAvailable: boolean;
  passkeys: PasskeySummary[];
  passkeysOpen: boolean;
  passkeysLoading: boolean;
  passkeysError: string | null;

  navigate(path: string, options?: { replace?: boolean }): void;

  retrySession(): void;
  signIn(token: string): Promise<void>;
  signOut(): void;
  signInWithPasskey(): Promise<void>;

  openPasskeys(): void;
  closePasskeys(): void;
  addPasskey(nickname: string): Promise<boolean>;
  removePasskey(id: string): Promise<boolean>;

  retryProjects(): void;
  createProject(input: NewProjectInput): Promise<Project>;
  projectCreated(project: Project): void;
  selectProject(key: string): void;

  projectDialog:
    | { mode: "create" }
    | { mode: "edit"; project: Project }
    | null;
  openNewProject(): void;
  openEditProject(project: Project): void;
  closeProjectDialog(): void;
  saveProject(input: NewProjectInput): Promise<boolean>;
  archiveProject(key: string): Promise<boolean>;
  restoreProject(key: string): Promise<boolean>;

  refresh(): void;
  retryDetail(): void;

  setQuery(value: string): void;
  setLabelFilter(label: string | null): void;
  openPalette(): void;
  closePalette(): void;
  togglePalette(): void;

  openNewIssue(status?: Status): void;
  closeNewIssue(): void;
  openIssue(issue: Issue): void;
  openIssueKey(key: string): void;

  createIssue(input: NewIssueInput): Promise<boolean>;
  move(key: string, status: Status): Promise<boolean>;
  unblock(key: string): Promise<boolean>;
  comment(key: string, body: string): Promise<boolean>;
  updateIssue(
    key: string,
    fields: { title?: string; description?: string; priority?: Priority },
  ): Promise<boolean>;
  setLabels(key: string, labels: string[]): Promise<boolean>;
  addRelation(key: string, blocking: string): Promise<boolean>;

  dismissToast(id: number): void;
}

export function useWorkspace({
  api,
  realtime,
  navigation,
  passkeys: passkeyCeremony,
}: WorkspaceDeps): Workspace {
  const { route } = navigation;

  const navigate = useCallback(
    (path: string, options?: { replace?: boolean }): void => {
      navigation.navigate(path, options);
    },
    [navigation],
  );

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

  const [query, setQueryState] = useState("");
  const [labelFilter, setLabelFilterState] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<
    { mode: "create" } | { mode: "edit"; project: Project } | null
  >(null);
  const [newIssueStatus, setNewIssueStatus] = useState<Status>("backlog");
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [passkeysLoading, setPasskeysLoading] = useState(false);
  const [passkeysError, setPasskeysError] = useState<string | null>(null);

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
      if (isUnauthorized(error)) {
        setAuth("anonymous");
      } else {
        setBootError(messageOf(error));
        setAuth("error");
      }
    }
  }, [api]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    let alive = true;
    void api
      .passkeyAvailable()
      .then((result) => {
        if (alive) {
          setPasskeyAvailable(result.available);
        }
      })
      .catch(() => {
        // The token form stays available when the probe fails.
      });
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    if (auth !== "human") {
      return;
    }
    let alive = true;
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
        if (isUnauthorized(error)) {
          onUnauthorized();
          return;
        }
        setProjectsError(messageOf(error));
        setProjectsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [auth, projectsTick, onUnauthorized, api]);

  const projectKeyFromRoute =
    route.project !== undefined &&
    projects.some((project) => project.key === route.project)
      ? route.project
      : projects[0]?.key ?? null;
  const project =
    projects.find((item) => item.key === projectKeyFromRoute) ?? null;

  // Progress mutations arrive through the projects payload, so refetch when
  // entering the projects page or a project overview.
  useEffect(() => {
    if (route.kind === "projects" || route.kind === "overview") {
      setProjectsTick((current) => current + 1);
    }
  }, [route.kind, projectKeyFromRoute]);

  useEffect(() => {
    if (auth !== "human" || projects.length === 0) {
      return;
    }
    if (route.kind === "projects") {
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
    if (route.kind === "new" && route.project === undefined) {
      return;
    }
    navigate(
      route.kind === "queue"
        ? queuePath(first.key)
        : route.kind === "new"
          ? newIssuePath(first.key)
          : boardPath(first.key),
      { replace: true },
    );
  }, [auth, projects, route, navigate]);

  useEffect(() => {
    setQueryState("");
    setLabelFilterState(null);
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
    setDetailError(null);
    setIssuesLoading(true);
  }, [projectKeyFromRoute]);

  const refresh = useCallback((): void => {
    setDataTick((current) => current + 1);
  }, []);

  useEffect(() => {
    if (
      auth !== "human" ||
      projectKeyFromRoute === null ||
      route.kind === "projects"
    ) {
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
        if (isUnauthorized(error)) {
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
  }, [auth, projectKeyFromRoute, route.kind, dataTick, onUnauthorized, api]);

  const issueKey = route.kind === "issue" ? route.key : null;

  const onEventsChange = useCallback((): void => {
    if (route.kind === "projects") {
      setProjectsTick((current) => current + 1);
      return;
    }
    refresh();
    if (route.kind === "overview") {
      setProjectsTick((current) => current + 1);
    }
    if (issueKey !== null) {
      setDetailTick((current) => current + 1);
    }
  }, [issueKey, refresh, route.kind]);

  realtime.useIssuesChanged({
    enabled:
      auth === "human" && (route.kind === "projects" || project !== null),
    projectId: route.kind === "projects" ? null : project?.id ?? null,
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
        if (isUnauthorized(error)) {
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
  }, [auth, issueKey, detailTick, projectKeyFromRoute, onUnauthorized, api]);

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
        if (isUnauthorized(error)) {
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

  const openNewIssue = useCallback(
    (status: Status = "backlog"): void => {
      setPaletteOpen(false);
      setNewIssueStatus(status);
      navigate(newIssuePath(projectKeyFromRoute ?? undefined));
    },
    [navigate, projectKeyFromRoute],
  );

  const closeNewIssue = useCallback((): void => {
    setNewIssueStatus("backlog");
    if (projectKeyFromRoute === null) {
      return;
    }
    if (parseRoute(window.location.pathname).kind !== "new") {
      return;
    }
    navigate(boardPath(projectKeyFromRoute), { replace: true });
  }, [navigate, projectKeyFromRoute]);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await api.signOut();
    } catch {
      // The session may already be gone; clear local state regardless.
    }
    onUnauthorized();
  }, [api, onUnauthorized]);

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
        if (isUnauthorized(error)) {
          onUnauthorized();
        }
        notify("error", messageOf(error));
        return false;
      }
    },
    [navigate, notify, onUnauthorized, project, refresh],
  );

  const upsertProject = useCallback((next: Project): void => {
    setProjects((current) =>
      [...current.filter((item) => item.key !== next.key), next].sort(
        (left, right) => left.key.localeCompare(right.key),
      ),
    );
    setProjectsLoaded(true);
  }, []);

  const projectCreated = useCallback(
    (created: Project): void => {
      upsertProject(created);
      navigate(overviewPath(created.key));
      notify("success", `Created project ${created.key}`);
    },
    [navigate, notify, upsertProject],
  );

  const openNewProject = useCallback((): void => {
    setPaletteOpen(false);
    setProjectDialog({ mode: "create" });
  }, []);

  const openEditProject = useCallback((target: Project): void => {
    setProjectDialog({ mode: "edit", project: target });
  }, []);

  const closeProjectDialog = useCallback((): void => {
    setProjectDialog(null);
  }, []);

  const saveProject = useCallback(
    async (input: NewProjectInput): Promise<boolean> => {
      if (projectDialog === null) {
        return false;
      }
      try {
        if (projectDialog.mode === "create") {
          const result = await api.createProject(input);
          upsertProject(result.project);
          setProjectDialog(null);
          navigate(overviewPath(result.project.key));
          notify("success", `Created project ${result.project.key}`);
        } else {
          const patch: ProjectPatch = {
            name: input.name,
            summary: input.summary,
            description: input.description,
            status: input.status,
            priority: input.priority,
            startDate: input.startDate,
            targetDate: input.targetDate,
          };
          const result = await api.updateProject(
            projectDialog.project.key,
            patch,
          );
          upsertProject(result.project);
          setProjectDialog(null);
          notify("success", `Updated project ${result.project.key}`);
        }
        return true;
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return false;
        }
        notify("error", messageOf(error));
        return false;
      }
    },
    [api, navigate, notify, onUnauthorized, projectDialog, upsertProject],
  );

  const archiveProject = useCallback(
    async (key: string): Promise<boolean> => {
      try {
        const result = await api.updateProject(key, { archived: true });
        upsertProject(result.project);
        notify("success", `Archived ${key}`);
        if (project?.key === key) {
          navigate(projectsPath());
        }
        return true;
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return false;
        }
        notify("error", messageOf(error));
        return false;
      }
    },
    [api, navigate, notify, onUnauthorized, project, upsertProject],
  );

  const restoreProject = useCallback(
    async (key: string): Promise<boolean> => {
      try {
        const result = await api.updateProject(key, { archived: false });
        upsertProject(result.project);
        notify("success", `Restored ${key}`);
        return true;
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return false;
        }
        notify("error", messageOf(error));
        return false;
      }
    },
    [api, notify, onUnauthorized, upsertProject],
  );

  const selectProject = useCallback(
    (key: string): void => {
      navigate(boardPath(key));
      setQueryState("");
      setLabelFilterState(null);
    },
    [navigate],
  );

  const setLabelFilter = useCallback(
    (label: string | null): void => {
      setLabelFilterState(label);
      if (project !== null && route.kind === "queue") {
        navigate(boardPath(project.key));
      }
    },
    [navigate, project, route.kind],
  );

  const setQuery = useCallback(
    (value: string): void => {
      setQueryState(value);
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

  const signIn = useCallback(
    async (token: string): Promise<void> => {
      await api.signIn(token);
      setAuth("human");
    },
    [api],
  );

  const signInWithPasskey = useCallback(async (): Promise<void> => {
    const start = await api.startPasskeyLogin();
    const response = await passkeyCeremony.authenticate(start.options);
    await api.finishPasskeyLogin({
      challengeId: start.challengeId,
      response,
    });
    setAuth("human");
    setPasskeyAvailable(true);
  }, [api, passkeyCeremony]);

  const loadPasskeys = useCallback(async (): Promise<void> => {
    setPasskeysLoading(true);
    setPasskeysError(null);
    try {
      const result = await api.passkeys();
      setPasskeys(result.passkeys);
    } catch (error) {
      if (isUnauthorized(error)) {
        onUnauthorized();
        return;
      }
      setPasskeysError(passkeyErrorMessage(error));
    } finally {
      setPasskeysLoading(false);
    }
  }, [api, onUnauthorized]);

  const openPasskeys = useCallback((): void => {
    setPasskeysOpen(true);
    void loadPasskeys();
  }, [loadPasskeys]);

  const closePasskeys = useCallback((): void => {
    setPasskeysOpen(false);
  }, []);

  const addPasskey = useCallback(
    async (nickname: string): Promise<boolean> => {
      if (!passkeyCeremony.supported) {
        notify("error", "This browser does not support passkeys.");
        return false;
      }
      setPasskeysLoading(true);
      setPasskeysError(null);
      try {
        const start = await api.startPasskeyRegistration();
        const response = await passkeyCeremony.register(start.options);
        await api.finishPasskeyRegistration({
          challengeId: start.challengeId,
          nickname,
          response,
        });
        setPasskeyAvailable(true);
        const result = await api.passkeys();
        setPasskeys(result.passkeys);
        notify("success", "Passkey added");
        return true;
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return false;
        }
        setPasskeysError(passkeyErrorMessage(error));
        return false;
      } finally {
        setPasskeysLoading(false);
      }
    },
    [api, notify, onUnauthorized, passkeyCeremony],
  );

  const removePasskey = useCallback(
    async (id: string): Promise<boolean> => {
      setPasskeysLoading(true);
      setPasskeysError(null);
      try {
        await api.deletePasskey(id);
        const result = await api.passkeys();
        setPasskeys(result.passkeys);
        setPasskeyAvailable(result.passkeys.length > 0);
        notify("success", "Passkey removed");
        return true;
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return false;
        }
        setPasskeysError(passkeyErrorMessage(error));
        return false;
      } finally {
        setPasskeysLoading(false);
      }
    },
    [api, notify, onUnauthorized],
  );

  const retrySession = useCallback((): void => {
    void checkSession();
  }, [checkSession]);

  const retryProjects = useCallback((): void => {
    setProjectsTick((current) => current + 1);
  }, []);

  const retryDetail = useCallback((): void => {
    setDetailTick((current) => current + 1);
  }, []);

  const createProject = useCallback(
    async (input: NewProjectInput): Promise<Project> => {
      const result = await api.createProject(input);
      return result.project;
    },
    [api],
  );

  const openPalette = useCallback((): void => {
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback((): void => {
    setPaletteOpen(false);
  }, []);

  const togglePalette = useCallback((): void => {
    setPaletteOpen((current) => !current);
  }, []);

  const move = useCallback(
    (key: string, status: Status): Promise<boolean> =>
      run(
        () => api.transition(key, status),
        `Moved ${key} to ${STATUS_LABEL[status]}`,
      ),
    [api, run],
  );

  const unblock = useCallback(
    (key: string): Promise<boolean> =>
      run(() => api.unblock(key), `Unblocked ${key}`),
    [api, run],
  );

  const comment = useCallback(
    (key: string, body: string): Promise<boolean> =>
      run(() => api.comment(key, body), "Comment added"),
    [api, run],
  );

  const updateIssue = useCallback(
    (
      key: string,
      fields: { title?: string; description?: string; priority?: Priority },
    ): Promise<boolean> =>
      run(() => api.updateIssue(key, fields), "Issue updated"),
    [api, run],
  );

  const setLabels = useCallback(
    (key: string, labels: string[]): Promise<boolean> =>
      run(() => api.setLabels(key, labels), "Labels updated"),
    [api, run],
  );

  const addRelation = useCallback(
    (key: string, blocking: string): Promise<boolean> =>
      run(
        () => api.addRelation(key, blocking),
        `Added ${blocking} as a blocker`,
      ),
    [api, run],
  );

  const dismissToast = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const allLabels = [...new Set(issues.flatMap((issue) => issue.labels))].sort(
    (left, right) => left.localeCompare(right),
  );
  const issueKeys = issues.map((issue) => issue.key);

  return {
    auth,
    bootError,
    projects,
    projectsLoaded,
    projectsError,
    project,
    issues,
    ready,
    issuesLoading,
    issuesError,
    refreshing,
    timeline,
    detailLoading,
    detailError,
    query,
    labelFilter,
    paletteOpen,
    newIssueStatus,
    toasts,
    route,
    issueKey,
    allLabels,
    issueKeys,

    passkeysSupported: passkeyCeremony.supported,
    passkeyAvailable,
    passkeys,
    passkeysOpen,
    passkeysLoading,
    passkeysError,

    navigate,

    retrySession,
    signIn,
    signOut,
    signInWithPasskey,

    openPasskeys,
    closePasskeys,
    addPasskey,
    removePasskey,

    retryProjects,
    createProject,
    projectCreated,
    selectProject,

    projectDialog,
    openNewProject,
    openEditProject,
    closeProjectDialog,
    saveProject,
    archiveProject,
    restoreProject,

    refresh,
    retryDetail,

    setQuery,
    setLabelFilter,
    openPalette,
    closePalette,
    togglePalette,

    openNewIssue,
    closeNewIssue,
    openIssue,
    openIssueKey,

    createIssue,
    move,
    unblock,
    comment,
    updateIssue,
    setLabels,
    addRelation,

    dismissToast,
  };
}
