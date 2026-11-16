-- Realtime wake-up for connected clients. Every change to an issue, and every
-- new event written to its history, publishes the owning project on the
-- `issues_changed` channel so an SSE stream can tell its subscribers to
-- refresh that project. The notification carries only the project id: it is a
-- hint to refetch, never the source of truth, so duplicate or missed messages
-- only cost an extra read.
create function notify_issue_change() returns trigger
language plpgsql
as $$
declare
  changed_project_id integer;
begin
  if tg_table_name = 'issues' then
    changed_project_id := new.project_id;
  else
    select project_id into changed_project_id from issues where id = new.issue_id;
  end if;

  if changed_project_id is not null then
    perform pg_notify('issues_changed', changed_project_id::text);
  end if;

  return new;
end;
$$;

-- Issues are mutable, so both inserts and updates are worth announcing.
create trigger issues_notify_change_after_insert
after insert on issues
for each row execute function notify_issue_change();

create trigger issues_notify_change_after_update
after update on issues
for each row execute function notify_issue_change();

-- issue_events stays append-only: only inserts fire, and the project is
-- resolved through the issue that owns the event.
create trigger issue_events_notify_change_after_insert
after insert on issue_events
for each row execute function notify_issue_change();
