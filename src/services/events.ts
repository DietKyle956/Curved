import type { QueryResultRow } from "pg";
import type { Db } from "../db.ts";
import type { ActorType, EventKind, Status } from "../shared/status.ts";

export interface IssueEvent {
  id: number;
  issueId: number;
  kind: EventKind;
  actorType: ActorType;
  fromStatus: Status | null;
  toStatus: Status | null;
  body: string | null;
  createdAt: string;
}

export interface AppendEventInput {
  issueId: number;
  kind: EventKind;
  actorType: ActorType;
  fromStatus?: Status | null;
  toStatus?: Status | null;
  body?: string | null;
}

interface EventRow extends QueryResultRow {
  id: string;
  issue_id: number;
  kind: EventKind;
  actor_type: ActorType;
  from_status: Status | null;
  to_status: Status | null;
  body: string | null;
  created_at: Date;
}

const EVENT_COLUMNS = `id, issue_id, kind, actor_type, from_status, to_status, body, created_at`;

function toEvent(row: EventRow): IssueEvent {
  return {
    id: Number(row.id),
    issueId: row.issue_id,
    kind: row.kind,
    actorType: row.actor_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

export async function appendEvent(
  db: Db,
  input: AppendEventInput,
): Promise<IssueEvent> {
  const row = await db.one<EventRow>(
    `insert into issue_events (issue_id, kind, actor_type, from_status, to_status, body)
     values ($1, $2, $3, $4, $5, $6)
     returning ${EVENT_COLUMNS}`,
    [
      input.issueId,
      input.kind,
      input.actorType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.body ?? null,
    ],
  );
  if (row === null) {
    throw new Error("issue event insert returned no row");
  }
  return toEvent(row);
}

export async function listEvents(db: Db, issueId: number): Promise<IssueEvent[]> {
  const rows = await db.query<EventRow>(
    `select ${EVENT_COLUMNS}
     from issue_events
     where issue_id = $1
     order by id asc`,
    [issueId],
  );
  return rows.map(toEvent);
}
