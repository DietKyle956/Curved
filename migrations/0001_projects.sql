-- Projects are the top-level container for issues. `key` is the stable prefix
-- of issue identifiers (for example `CURVED-12`).
create table projects (
  id integer generated always as identity primary key,
  key text not null unique,
  name text not null,
  next_number integer not null default 1,
  created_at timestamptz not null default now(),

  constraint projects_key_format check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  constraint projects_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint projects_next_number_positive check (next_number >= 1)
);
