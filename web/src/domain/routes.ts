export type Route =
  | { kind: "board"; project?: string }
  | { kind: "queue"; project?: string }
  | { kind: "issue"; project: string; key: string }
  | { kind: "new"; project?: string };

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
