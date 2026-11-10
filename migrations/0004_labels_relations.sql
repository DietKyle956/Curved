-- Labels are per-project names applied to issues. A label is created the first
-- time an issue in its project uses it, so two projects may each own a label
-- with the same name. Names are trimmed and bounded at the boundary.
create table labels (
  id integer generated always as identity primary key,
  project_id integer not null references projects(id),
  name text not null,
  created_at timestamptz not null default now(),
  constraint labels_project_name_unique unique (project_id, name),
  constraint labels_name_trimmed check (name = btrim(name)),
  constraint labels_name_length check (char_length(name) between 1 and 50)
);

-- The set of labels on an issue. Replacing an issue's labels rewrites these
-- rows wholesale; labels themselves are never removed.
create table issue_labels (
  issue_id integer not null references issues(id),
  label_id integer not null references labels(id),
  primary key (issue_id, label_id)
);

-- A directed edge: the blocking issue must reach `done` before the blocked
-- issue is ready to claim. Cycles are allowed to be recorded; the ready queue
-- simply never releases an issue whose blockers are unfinished.
create table issue_relations (
  blocking_issue_id integer not null references issues(id),
  blocked_issue_id integer not null references issues(id),
  created_at timestamptz not null default now(),
  primary key (blocking_issue_id, blocked_issue_id),
  constraint issue_relations_not_self check (blocking_issue_id <> blocked_issue_id)
);

-- The ready queue asks which edges point at a candidate issue.
create index issue_relations_blocked_idx on issue_relations (blocked_issue_id);
