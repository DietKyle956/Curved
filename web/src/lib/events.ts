import { useEffect, useRef } from "react";

const EVENTS_PATH = "/api/events";
const ISSUES_CHANGED_EVENT = "issues_changed";
const RETRY_DELAY_MS = 1_000;

export interface IssueEventsOptions {
  enabled: boolean;
  projectId: number | null;
  onChange: (projectId: number) => void;
}

export function useIssueEvents({
  enabled,
  projectId,
  onChange,
}: IssueEventsOptions): void {
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled || projectId === null) {
      return;
    }

    const target = projectId;
    let source: EventSource | null = null;
    let retry: number | null = null;
    let disposed = false;

    const connect = (): void => {
      retry = null;
      if (disposed) {
        return;
      }
      const next = new EventSource(EVENTS_PATH);
      source = next;
      next.addEventListener(ISSUES_CHANGED_EVENT, (event: Event): void => {
        if (disposed || source !== next) {
          return;
        }
        const data: unknown = (event as MessageEvent<unknown>).data;
        if (typeof data !== "string") {
          return;
        }
        const changed = Number.parseInt(data, 10);
        if (!Number.isInteger(changed) || changed !== target) {
          return;
        }
        onChangeRef.current(changed);
      });
      next.onerror = (): void => {
        if (disposed) {
          return;
        }
        next.close();
        if (source === next) {
          source = null;
        }
        if (retry !== null) {
          return;
        }
        retry = window.setTimeout(() => {
          connect();
        }, RETRY_DELAY_MS);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retry !== null) {
        window.clearTimeout(retry);
        retry = null;
      }
      if (source !== null) {
        source.close();
        source = null;
      }
    };
  }, [enabled, projectId]);
}
