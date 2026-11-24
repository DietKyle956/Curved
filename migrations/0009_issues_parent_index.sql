-- Sub-issues read their parent's key on every issue payload and list a
-- parent's direct children, so the self-reference needs its own index. The
-- foreign key and the not-self check already exist from 0002; same-project
-- parentage is enforced in the service layer because a CHECK cannot read
-- another row.
create index issues_parent_idx on issues (parent_id) where parent_id is not null;
