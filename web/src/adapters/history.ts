// History adapter: owns window.history and popstate, exposes the current route.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NavigationPort } from "../application/ports.ts";
import { parseRoute, type Route } from "../domain/routes.ts";

export const NAVIGATE_EVENT = "navigate";

export interface NavigateEventDetail {
  path: string;
  replace: boolean;
}

function dispatchNavigate(path: string, replace: boolean): void {
  window.dispatchEvent(
    new CustomEvent<NavigateEventDetail>(NAVIGATE_EVENT, {
      detail: { path, replace },
    }),
  );
}

export function useHistoryRouter(): NavigationPort {
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

  return useMemo<NavigationPort>(
    () => ({ route, navigate }),
    [route, navigate],
  );
}
