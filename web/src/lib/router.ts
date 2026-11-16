import { useCallback, useEffect, useState } from "react";

export const NAVIGATE_EVENT = "navigate";

export interface NavigateEventDetail {
  path: string;
  replace: boolean;
}

export type Route =
  | { kind: "board"; project?: string }
  | { kind: "queue"; project?: string }
  | { kind: "issue"; project: string; key: string }
  | { kind: "new"; project?: string };

function dispatchNavigate(path: string, replace: boolean): void {
  window.dispatchEvent(
    new CustomEvent<NavigateEventDetail>(NAVIGATE_EVENT, {
      detail: { path, replace },
    }),
  );
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (segment === undefined || segment.length === 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments[0] === "new") {
    return { kind: "new" };
  }

  if (segments[0] === "p" && segments[1] !== undefined) {
    const project = decodeSegment(segments[1]);
    if (segments[2] === "queue") {
      return { kind: "queue", project };
    }
    if (segments[2] === "new" && segments[3] === undefined) {
      return { kind: "new", project };
    }
    if (segments[2] === "i" && segments[3] !== undefined) {
      const key = decodeSegment(segments[3]);
      if (project !== undefined && key !== undefined) {
        return { kind: "issue", project, key };
      }
    }
    return { kind: "board", project };
  }

  return { kind: "board" };
}

export function boardPath(project: string): string {
  return `/p/${encodeURIComponent(project)}`;
}

export function queuePath(project: string): string {
  return `/p/${encodeURIComponent(project)}/queue`;
}

export function issuePath(project: string, key: string): string {
  return `/p/${encodeURIComponent(project)}/i/${encodeURIComponent(key)}`;
}

export function newIssuePath(project?: string): string {
  return project === undefined ? "/new" : `/p/${encodeURIComponent(project)}/new`;
}

export function useRoute(): {
  route: Route;
  navigate: (path: string, options?: { replace?: boolean }) => void;
} {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = (): void => {
      const path = window.location.pathname;
      setRoute(parseRoute(path));
      dispatchNavigate(path, false);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  const navigate = useCallback(
    (path: string, options?: { replace?: boolean }): void => {
      const replace = options?.replace === true;
      if (replace) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }
      setRoute(parseRoute(path));
      dispatchNavigate(path, replace);
    },
    [],
  );

  return { route, navigate };
}
