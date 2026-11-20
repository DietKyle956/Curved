alter table projects
  add column summary text not null default '',
  add column description text not null default '',
  add column status text not null default 'planned',
  add column priority integer,
  add column start_date date,
  add column target_date date,
  add column archived_at timestamptz,
  add column updated_at timestamptz not null default now();

-- Existing projects with work are in progress; containers with no issues stay planned.
update projects p
set status = case
  when exists (select 1 from issues i where i.project_id = p.id) then 'in_progress'
  else 'planned'
end;

alter table projects
  add constraint projects_status_valid check (
    status in ('backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled')
  ),
  add constraint projects_priority_valid check (priority is null or priority in (1, 2, 3, 4)),
  add constraint projects_summary_length check (char_length(btrim(summary)) <= 255),
  add constraint projects_description_length check (char_length(description) <= 20000);
