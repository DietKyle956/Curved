-- Issues live under a project. `key` is the human identifier: `projects.key`
-- plus the per-project `number` (for example `CURVED-12`), unique across all
-- projects and enforced to match `^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$`.
--
-- There is deliberately no `on delete cascade` anywhere in this schema: an
-- issue that has history cannot be deleted, and deleting a project that still
-- owns issues is rejected the same way.
create table issues (
  id integer generated always as identity primary key,
  project_id integer not null references projects(id),
  number integer not null,
  key text not null unique,
  title text not null,
  description text not null default '',
  status text not null default 'backlog',
  priority integer not null default 3,
  parent_id integer references issues(id),
  blocked_reason text,
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint issues_project_number_unique unique (project_id, number),
  constraint issues_number_positive check (number >= 1),
  constraint issues_key_format check (key ~ '^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$'),
  constraint issues_title_length check (char_length(btrim(title)) between 1 and 500),
  constraint issues_status_valid check (status in ('backlog', 'todo', 'in_progress', 'in_review', 'done')),
  constraint issues_priority_valid check (priority in (1, 2, 3, 4)),
  constraint issues_blocked_reason_length check (
    blocked_reason is null or char_length(btrim(blocked_reason)) between 1 and 2000
  ),
  constraint issues_parent_not_self check (parent_id is null or parent_id <> id)
);

-- `claimed_by` stays text until agent identity lands in LAS-145; it then
-- becomes a foreign key to the actor table.
--
-- issue_events is the append-only history for every issue. Rows are inserted
-- once and never mutated: the trigger below rejects UPDATE and DELETE with
-- SQLSTATE 23001.
create table issue_events (
  id bigint generated always as identity primary key,
  issue_id integer not null references issues(id),
  kind text not null,
  actor_type text not null,
  from_status text,
  to_status text,
  body text,
  created_at timestamptz not null default now(),

  constraint issue_events_kind_valid check (kind in (
    'created', 'status', 'comment', 'claim', 'release', 'blocked', 'unblocked', 'labels', 'relation'
  )),
  constraint issue_events_actor_valid check (actor_type in ('agent', 'human', 'git', 'system')),
  constraint issue_events_from_status_valid check (
    from_status is null or from_status in ('backlog', 'todo', 'in_progress', 'in_review', 'done')
  ),
  constraint issue_events_to_status_valid check (
    to_status is null or to_status in ('backlog', 'todo', 'in_progress', 'in_review', 'done')
  ),
  constraint issue_events_body_length check (body is null or char_length(body) >= 1)
);

-- History is append-only: every UPDATE and DELETE raises SQLSTATE 23001.
create function issue_events_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'issue_events is append-only: % is not allowed', tg_op
    using errcode = '23001';
end;
$$;

create trigger issue_events_append_only
before update or delete on issue_events
for each row execute function issue_events_append_only();
