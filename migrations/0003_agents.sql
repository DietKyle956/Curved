-- Agents are the actors that may claim issues. A row is created by
-- `agent add <name>`; the plaintext token is printed once and only its SHA-256
-- hash is stored. `issues.claimed_by` refers to the agent name and an agent may
-- hold at most one active claim at a time.
create table agents (
  id integer generated always as identity primary key,
  name text not null unique,
  token_hash text not null unique,
  created_at timestamptz not null default now(),

  constraint agents_name_trimmed check (name = btrim(name)),
  constraint agents_name_length check (char_length(name) between 1 and 100),
  constraint agents_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$')
);

-- Existing claims refer to agents that predate this table. Backfill them with
-- an unusable random hash so no stored token can ever authenticate; those
-- agents must be re-created to receive a token.
insert into agents (name, token_hash)
select distinct
  claimed_by,
  encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex')
from issues
where claimed_by is not null
on conflict (name) do nothing;

-- Before the one-active-claim index, demote duplicate active claims so the
-- index can be created. The earliest claim per agent by issue number is kept.
with ranked as (
  select
    id,
    row_number() over (partition by claimed_by order by number asc, id asc) as position
  from issues
  where claimed_by is not null and status in ('in_progress', 'in_review')
)
update issues
set claimed_by = null
from ranked
where issues.id = ranked.id and ranked.position > 1;

alter table issues
  add constraint issues_claimed_by_fkey foreign key (claimed_by) references agents(name);

-- The claim fence: an agent holds at most one issue that is in progress or in
-- review. Released or completed issues free the agent for the next claim.
create unique index issues_one_active_claim_per_agent
  on issues (claimed_by)
  where status in ('in_progress', 'in_review') and claimed_by is not null;

-- `review_submitted` records a claim-holder handing an issue to review.
alter table issue_events drop constraint issue_events_kind_valid;
alter table issue_events add constraint issue_events_kind_valid check (kind in (
  'created', 'status', 'comment', 'claim', 'release', 'review_submitted', 'blocked', 'unblocked', 'labels', 'relation'
));
