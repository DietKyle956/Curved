# Architecture contract

Where code lives in `curved`, what may import what, and which module owns each
rule. Read this before adding a module or moving one.

This file is written in two tenses and marks them:

- **Current** names paths that exist in the repository today.
- **Target** names the layout the refactor is moving to. Step 2 (domain
  extraction, LAS-169) and step 3's first three slices (LAS-170, ports and the
  projects resource; LAS-171, the issues resource, its event and meta
  repositories, and the read model; LAS-172, agents, claims, review, comments,
  and blocking) are done: `src/domain/` holds the pure rules,
  `src/application/` holds the ports, the projects, issues, agents, queue,
  blocking, and comments use cases, and the issue read model, and
  `src/adapters/postgres/` holds the project, issue, event, meta, and agent
  repositories plus the ports factory. `src/composition/` does not exist yet,
  and `src/services/` holds only the modules not yet migrated (`labels.ts`,
  `relations.ts`, and `github.ts`). No claim below about a target path is a
  claim of existing code.

The product constraints themselves (status machine, one active claim per agent,
append-only history) are in `AGENTS.md` and `initial_idea.md`. This file is about
where their implementation lives.

## 1. Layers and the dependency rule

Dependencies point inward. Always.

```
inbound adapters  ->  application  ->  domain
outbound adapters ->  application  ->  domain
composition roots ->  adapters + application + domain
```

| Layer | Owns | May import | Current home | Target home |
|---|---|---|---|---|
| Domain | Pure rules and types: status contract, transition graph, actor matrix, claim policy, validation, key parsing, domain errors, pure GitHub text helpers | Nothing but TypeScript and other domain modules | `src/domain/` (`status.ts`, `transition.ts`, `actors.ts`, `claim.ts`, `move-policy.ts`, `validation.ts`, `keys.ts`, `errors.ts`, `types.ts`) | `src/domain/` |
| Application | Use cases, ports, transaction boundaries, authorization sequencing, error translation policy, the issue read model | Domain and its own ports | `src/application/` (`ports.ts`, `projects.ts`, `issues.ts`, `issue-read-model.ts`, `agents.ts`, `queue.ts`, `blocking.ts`, `comments.ts`); `src/services/` holds only the unmigrated `labels.ts`, `relations.ts`, and `github.ts` | `src/application/` |
| Outbound adapters | Implement ports: Postgres repositories, token codec, LISTEN client | Domain; application (ports and use cases) | `src/adapters/postgres/` (repositories `projects.ts`, `issues.ts`, `issue-events.ts`, `issue-meta.ts`, `agents.ts`; ports factory), `src/adapters/token-codec.ts`, `src/db.ts` (pool, transactions, pg error helpers), the table SQL still owned by `src/services/labels.ts` and `src/services/relations.ts` behind the ad-hoc `Db`/`Database` surface, the `pg.Client` inside `src/http/event-hub.ts` | `src/adapters/postgres/`, `src/adapters/token-codec.ts` |
| Inbound adapters | Translate external formats: HTTP routing plus cookies, MCP schemas plus results, CLI argv plus output, GitHub signature verification, SSE frames, static SPA files | Domain; application (ports and use cases); sanctioned peer adapters only | `src/http/*.ts`, `src/mcp/*.ts`, `src/cli.ts` | `src/adapters/http/`, `src/adapters/mcp/`, `src/adapters/cli/`, `src/adapters/github/`, `src/adapters/sse/`, `src/adapters/static/` |
| Composition roots | Read environment, create the pool, construct adapters, wire ports into use cases, own shutdown | Everything inward | `src/server.ts`, `src/cli.ts` (`withDatabase`), `src/mcp/server.ts` (`main`), `src/migrate.ts`; `src/config.ts` is only their `loadConfig` helper | `src/composition/` |

Target server tree:

```
src/
  domain/                 status.ts  transition.ts  actors.ts  claim.ts
                          move-policy.ts  validation.ts  keys.ts  errors.ts
                          types.ts
  application/
    ports.ts              ProjectRepository, IssueRepository, IssueEventRepository,
                          IssueMetaRepository, AgentRepository, LabelRepository,
                          RelationRepository, TokenCodec, Ports, TransactionPorts,
                          ActiveClaimConflict
    projects.ts  issues.ts  issue-read-model.ts  agents.ts  queue.ts
    comments.ts  blocking.ts  labels.ts  relations.ts  github.ts
  adapters/
    postgres/             ports.ts  pool.ts  repositories/*.ts  event-hub.ts
                          migrate.ts
    token-codec.ts
    http/                 app.ts  transport.ts  auth.ts  errors.ts
                          webhook.ts
    mcp/                  server.ts  tools.ts
    cli/                  cli.ts
    github/               signature.ts  payload.ts
    sse/                  stream.ts
    static/               spa.ts
  composition/            server.ts  cli.ts  mcp.ts  migrate.ts
```

Two files disambiguate transfers: `src/adapters/http/transport.ts` owns the Node
request/response bridge now in `src/server.ts` (`toRequest`, `writeResponse`,
`streamEventStream`); `src/adapters/postgres/migrate.ts` owns the migration runner
plus ledger SQL, so `src/composition/migrate.ts` is only the process entrypoint
(argv, config, pool, exit code). `src/adapters/postgres/ports.ts` owns the
`bindPorts` per-transaction factory and the `createPorts` aggregate factory.

The split between inbound HTTP and GitHub/SSE/static adapters is about format
ownership, not process boundaries: today `src/http/app.ts` calls
`handleGithubWebhook`, `createEventStreamResponse`, and `serveSpa` directly, and
that stays a function call from the HTTP adapter into those adapters in the
target. That call is the only sanctioned adapter-to-adapter direction: the set is
exactly `http` -> `github`, `sse`, `static`. No adapter may import any other
peer adapter; the HTTP layer never reaches into Postgres, MCP, or CLI.

### Composition root rule

A composition root is the only place allowed to:

- read environment configuration (`loadConfig`, `.env`, `process.env`);
- create the database pool and any long-lived client (the SSE `LISTEN` client);
- construct adapters and pass ports into use cases;
- own shutdown and signal handling (`SIGINT`/`SIGTERM`, `app.close()`,
  `hub.close()`, `server.close()`, `db.close()`).

A composition root contains no business rules: no validation beyond refusing to
start with a missing required secret, no status logic, no SQL, no error
translation. Today this is already mostly true, but it is spread across four
entrypoints that each resolve their own configuration
(`src/server.ts`, `src/cli.ts`, `src/mcp/server.ts`, `src/migrate.ts`), and
three of them create a database pool on their own. The target keeps one
composition module per entrypoint under `src/composition/`.

## 2. Where the rules live, and no second copy

Each rule has exactly one owning module. The table names the target owner, the
current location, and the only mirror that is allowed. Since step 2 each domain
rule is defined once, at the current location shown; since LAS-171 the issue
read model lives in `src/application/` as well, so no rule below is defined in
`src/services/`.

| Rule | Target owner | Current location | Allowed mirror |
|---|---|---|---|
| Status, priority, event-kind, and actor-type contract; `isStatus`, `isPriority`, `isActorType`; `DEFAULT_STATUS`, `DEFAULT_PRIORITY` | `src/domain/status.ts` | `src/domain/status.ts` | Postgres CHECK constraints |
| Legal transition graph `TRANSITIONS`, `LEGAL_EDGES`, `isLegalTransition` | `src/domain/transition.ts` | `src/domain/transition.ts` | None |
| Actor matrix `ACTOR_TRANSITIONS`, `actorMayTransition` | `src/domain/actors.ts` | `src/domain/actors.ts` | None |
| Actor-context resolution: `resolveContext`, `validateActor`, deriving whether an agent owns the active claim | `src/domain/actors.ts` | `src/domain/actors.ts` | None |
| Shared domain types `Issue`, `Project`, `Agent`, `CreatedAgent`, `IssueEvent`, `IssueMeta`, `IssueRelations`, `emptyMeta` | `src/domain/types.ts` | `src/domain/types.ts` | None |
| `allowedTransitions` and `TransitionContext` | `src/domain/actors.ts` | `src/domain/actors.ts` | None; the SPA reads `allowedTransitions` from the payload and never recomputes it |
| Move authority (`mayMove`) | `src/domain/move-policy.ts` | `src/domain/move-policy.ts` | None |
| Claim-column policy (`nextClaimedBy`: clear on `todo`/`backlog`, set by an agent claim, keep otherwise) | `src/domain/claim.ts` | `src/domain/claim.ts` | None |
| One active issue per agent (the fence) | `src/domain/claim.ts` states the policy; the use case maps the conflict | partial unique index `issues_one_active_claim_per_agent` (`migrations/0003_agents.sql`), plus the translation to `ActiveClaimConflict` in `src/adapters/postgres/repositories/issues.ts`, its mapping in `src/application/issues.ts`, and the mapping in `src/application/queue.ts` | The index is the enforcement mirror; it is not the policy source |
| Validation: project key and name, issue title/priority/status, label normalization, block reason, agent name, and their max-length constants | `src/domain/validation.ts` | `src/domain/validation.ts` | Postgres CHECK constraints; adapter shape checks |
| Key parsing and normalization: `parseIssueKey`, `issueKeyFromText`, `branchNameForIssue` | `src/domain/keys.ts` | `src/domain/keys.ts` | None; adapter regexes must import these |
| Domain errors `ServiceError`, `ERROR_CODES` | `src/domain/errors.ts` | `src/domain/errors.ts` | None; HTTP status mapping is adapter-only, in `src/http/errors.ts` |
| Issue read model: project a stored row plus actor context plus meta, derive `allowedTransitions` | `src/application/issue-read-model.ts` | `toIssue`, `hydrateIssue` in `src/application/issue-read-model.ts` | None |

`allowedTransitions` and `TransitionContext` live in `src/domain/actors.ts`, next
to the actor matrix they are built from, so `src/domain/transition.ts` never
imports the matrix; that keeps the domain import graph acyclic.

### No second copy

- Exactly one module may define each value, function, regex, transition list,
  actor matrix, default, or error code above. Every other layer imports it.
- A second copy is forbidden, not discouraged. That includes a literal
  `STATUSES` array in an adapter, a second `^[A-Z][A-Z0-9]{1,9}` regex, a copied
  edge list, a recomputed `allowedTransitions` in the SPA, or a second
  `ServiceError`-like class.
- Duplicates LAS-169 deleted, recorded so they do not return:
  `PROJECT_KEY_PATTERN` and `ISSUE_KEY_PATTERN` in `src/mcp/tools.ts` (zod
  schemas), `ISSUE_KEY_PATTERN`/`PROJECT_KEY_PATTERN` in the since-deleted
  `src/services/issues.ts`, `KEY_PATTERN` in `src/services/projects.ts` (also
  since deleted), and `ISSUE_KEY_IN_TEXT` in `src/services/github.ts`. Each of
  those sites imported from `src/domain/keys.ts` while it existed; a future
  adapter or service that needs a key format imports it too and never declares
  its own.

### How legitimate mirrors are bounded

- **Postgres.** CHECK constraints and indexes cannot import TypeScript, so they
  restate domain values physically, for example `projects_key_format`,
  `issues_key_format`, `issues_status_valid`, `issues_priority_valid`,
  `issues_blocked_reason_length`, `projects_name_length`, `issues_title_length`
  (`migrations/0001_projects.sql`, `0002_issues.sql`), `issue_events_kind_valid`
  (`0002`, widened in `0003` to add `review_submitted`), `issue_events_actor_valid`
  (`0002`, never altered), `agents_name_length`,
  `agents_token_hash_format`, the partial unique claim index `0003`,
  `labels_name_length` (`0004`), and `issue_relations_not_self` (`0004`).
  These are a storage-level backstop, never a second implementation. The domain
  module is the source of truth; a value change lands in the domain module and
  the matching migration in the same commit.
- **Web.** The SPA imports the backend contract instead of redeclaring enums:
  `web/src/lib/types.ts` imports `ActorType`, `EventKind`, `Priority`, `Status`
  from `../../../src/domain/status.ts` and re-exports them, and
  `web/src/lib/presentation.ts` imports `STATUSES` for ordering. Presentation maps
  (`STATUS_LABEL`, `STATUS_TONE`, `PRIORITY_LABEL`, `EVENT_LABEL`) are display
  data, not a copy of the contract, and are allowed in the web domain.
  The allowlist is the limit: the only backend module a web module may import is
  `src/domain/status.ts`. Importing
  `src/services/**` or any other backend module is forbidden.
- **Adapter pre-filters.** MCP zod schemas and HTTP field checks may restate a
  numeric bound to produce a fast, well-shaped error at the edge. They may not
  restate a pattern: a zod schema or adapter check that needs a key or name
  format imports the domain regex constant. They are pre-filters either way: the
  domain re-validates, and the adapter must call the domain function rather than
  own a competing regex.
- Anything outside those three cases (a hand-maintained enum copy, a second
  transition table, a duplicated authority check) is a defect, not a mirror.

## 3. Current state and migration path

Steps 1 and 2 of the migration are done, and so are step 3's first three
slices: this contract exists, the pure rules live in `src/domain/`, and the
projects, issues, agents, claims, review, comments, and blocking resources run
through application use cases over ports. The remaining old modules are the
transitional home for the rest of step 3 through step 6. Four former homes are
gone: the old shared status module split into
`src/domain/status.ts`, `src/domain/transition.ts`, and `src/domain/actors.ts`;
the old root error module became `src/domain/errors.ts` plus the HTTP mapping in
`src/http/errors.ts`; `src/services/issues.ts`, `src/services/events.ts`, and
`src/services/issue-meta.ts` became `src/application/issues.ts`,
`src/application/issue-read-model.ts`, and the Postgres issue repositories; and
`src/services/agents.ts`, `src/services/queue.ts`, `src/services/blocking.ts`,
and `src/services/comments.ts` became `src/application/agents.ts`,
`src/application/queue.ts`, `src/application/blocking.ts`, and
`src/application/comments.ts`.

| Transitional home | Holds today | Target |
|---|---|---|
| `src/services/*.ts` | Only the resources not yet migrated, mixed: `labels.ts`, `relations.ts`, and `github.ts` hold their use cases, and `labels.ts` and `relations.ts` still own their table SQL | Split into application use cases plus Postgres repositories |
| `src/db.ts` | Pool, `Db`/`Database` interfaces, transactions, `pgErrorCode`, `pgErrorConstraint` | `src/adapters/postgres/pool.ts` plus port implementations |
| `src/services/github.ts` | Signature verification, payload parsing, and `applyPullRequestEvent` | `src/adapters/github/{signature,payload}.ts` (signature and payload parsing); `src/application/github.ts` (`applyPullRequestEvent`, which calls `moveIssue`) |
| `src/http/`, `src/mcp/`, `src/cli.ts` | Inbound adapters | `src/adapters/http/`, `src/adapters/mcp/`, `src/adapters/cli/` |
| `src/config.ts` | `loadConfig`, called today by the four entrypoints and by `test/helpers/db.ts` | A config module consumed only by composition; `loadConfig` may be called only from composition |
| `src/server.ts`, `src/migrate.ts`, `src/mcp/server.ts` | Composition, scattered; `server.ts` also holds the Node request/response bridge (`toRequest`, `writeResponse`, `streamEventStream`) | `src/composition/`, with the bridge moved to `src/adapters/http/transport.ts` and `src/migrate.ts` split: runner plus ledger SQL to `src/adapters/postgres/migrate.ts`, process entrypoint only to `src/composition/migrate.ts` |
| `web/src/lib/{types,presentation,router}.ts` | Domain-ish types and rules, but `router.ts` also owns history and React hooks | `web/src/domain/` plus `web/src/adapters/history.ts` |
| `web/src/lib/{api,events}.ts` | Transport | `web/src/adapters/` behind ports |
| `web/src/app.tsx` | 786 lines of auth, loading, refresh, actions, toasts, and route-driven dialogs | Deleted: orchestration to `web/src/application/workspace.ts`; `web/src/main.tsx` keeps the thin ui wiring (imports workspace and ui, renders once) |
| `web/src/components/*.tsx` | UI, mostly prop-driven | `web/src/ui/` |

Migration is expand-contract, one step per work item:

| Step | Work | Exit criterion |
|---|---|---|
| 1. Codify | Done: this file; a rule inventory; keep the existing suite green | Met: every rule in section 2 has one named owner |
| 2. Extract domain | Done (LAS-169, 2026-11-17): created `src/domain/`, moved the pure rules, and made services import them | Met: no domain rule remains defined inside `src/services/`; tests changed only their import paths |
| 3. Ports and Postgres | In progress: LAS-170 (2026-11-17) added the ports module, the projects use cases, and the project repository; LAS-171 (2026-11-17) added the issues use cases, the read model, and the issue, event, meta, and agent ports with their repositories; LAS-172 (2026-11-17) added the agent, queue, blocking, and comment use cases, extended the agent and issue ports, deleted the four matching service modules, and rewired HTTP, CLI, and MCP onto ports. Remaining: LAS-173 (labels, relations, GitHub use case). Also move event-hub construction out of `createApp` (`src/http/app.ts` builds it via `createEventHub` when no hub is injected) into the composition root | Application modules import no `pg` and no `src/db.ts`; the HTTP adapter receives a hub it did not construct |
| 4. Rewire inbound adapters, delete old modules | Move HTTP, MCP, CLI, GitHub, SSE, static; add `src/composition/`; delete `src/services/`, `src/db.ts` (the web repoint to `src/domain/status.ts` already landed with step 2) | No import of a deleted path; behavior unchanged, 189 tests green |
| 5. Web layering | Split `web/src` into `domain/`, `application/`, `adapters/`, `ui/`; move orchestration out of `app.tsx`; delete `web/src/lib/` and distribute its contents to domain, application, and adapters; remove `api` imports from components | Typecheck and build green; components import no transport; no module imports `web/src/lib/`; browser pass at 390x844 and desktop |
| 6. Completion gate | Add the import-direction check and wire it into `npm run check` | `npm run check` green with no undocumented exception |

Step 3 lands one resource per work item. The first slice (LAS-170) added the
ports module in `src/application/ports.ts`, the Postgres project repository under
`src/adapters/postgres/repositories/`, the `createPorts` factory, and the token
codec; moved the projects use cases to `src/application/projects.ts` with no SQL;
deleted `src/services/projects.ts`; and made the HTTP app, the CLI, and the agent
token helpers use the boundary. The second slice (LAS-171) declared the issue,
event, meta, and agent ports plus `bindPorts`; moved the issue use cases to
`src/application/issues.ts` and the read model to
`src/application/issue-read-model.ts` with no SQL and no pg import; added the
Postgres issue, issue-event, issue-meta, and agent repositories; deleted
`src/services/issues.ts`, `src/services/events.ts`, and
`src/services/issue-meta.ts`; and rewired the HTTP issue routes, the webhook,
the CLI, MCP, and the not-yet-migrated services through the boundary. The third
slice (LAS-172) added the agent, queue, blocking, and comment use cases in
`src/application/` with no SQL, extended the agent port with create, find by
token hash, find by name, and the per-agent advisory claim lock, extended the
issue port with block, unblock, and the locked claim candidate, deleted
`src/services/agents.ts`, `src/services/queue.ts`, `src/services/blocking.ts`,
and `src/services/comments.ts`, and rewired the HTTP routes, the CLI, and MCP
onto ports. The next slice is LAS-173 (labels, relations, GitHub use case),
after which every resource is behind ports.

Rules that hold across every step:

- Behavior does not change in steps 2 to 5. Public function names and input
  shapes in the resource modules stay where callers and tests depend on them;
  error codes and messages stay identical; HTTP bodies and statuses stay
  identical.
- No re-export shims and no dual conventions survive. A transitional re-export is
  allowed only inside the single work item that moves a symbol, and it is
  deleted before that work item ends. At completion there is one spelling per
  path and one convention per concern. A module importing both an old and a new
  location is a defect.

## 4. Ports and transactions

Target: ports are declared in application and implemented in adapters. Today
the project, issue, event, meta, and agent ports exist (Current note below);
labels and relations are still target. `src/db.ts` still owns the pool,
transactions, and the pg error helpers, while the unmigrated SQL lives inside
`src/services/labels.ts` and `src/services/relations.ts` and is called through
the ad-hoc `Db`/`Database` surface.

- One ports module: `src/application/ports.ts`. It also declares the port-level
  `ActiveClaimConflict` error, alongside `Ports` and `TransactionPorts`; projects,
  issues, events, meta, agents, and tokens are implemented so far.
- Naming convention: `<Noun>Repository` for persistence, `TokenCodec` for token
  mint/verify. No `Service`, `Gateway`, `Provider`, or `Manager` suffix.
- A `Ports` aggregate exposes the repositories plus `transaction(fn)`. The
  callback receives `TransactionPorts`: the same repositories bound to the
  transaction, with no `transaction` member, so a nested call cannot type-check:

```ts
interface TransactionPorts {
  projects: ProjectRepository;
  issues: IssueRepository;
  agents: AgentRepository;
  events: IssueEventRepository;
  meta: IssueMetaRepository;
  labels: LabelRepository;
  relations: RelationRepository;
  tokens: TokenCodec;
}

interface Ports extends TransactionPorts {
  transaction<T>(fn: (ports: TransactionPorts) => Promise<T>): Promise<T>;
}
```

Current: the landed ports are `ProjectRepository` (create, list, findByKey),
`IssueRepository` (create with allocation, findById, findByKey, lockByKey, list,
updateFields, updateStatus, block, unblock, lockClaimCandidate,
findActiveClaimKey, listReady), `IssueEventRepository` (append, list),
`IssueMetaRepository` (loadForIds), `AgentRepository` (create, findByTokenHash,
findByName, acquireClaimLock), `TokenCodec` (mint, hash),
`ActiveClaimConflict`, `TransactionPorts` with projects, issues, events, meta,
agents, and tokens, and `Ports` with `transaction`. `bindPorts(db)` binds the
repositories to a given executor, and `createPorts(database)` delegates to it,
binding to the pool or, inside `transaction(fn)`, to the transaction's
connection; with no `transaction` member on `TransactionPorts`, a nested
transaction cannot type-check.

Repository inventories:

| Repository | Operations |
|---|---|
| `ProjectRepository` | create (duplicate-key translation), list ordered by key, find by key |
| `IssueRepository` | create with atomic per-project number allocation; find by id; find by key; lock by key; list with project and status filters ordered by project then number; update mutable fields; update status and claim column; block in one statement (status `todo`, claim cleared, reason recorded); unblock in one statement (reason cleared, status and claim untouched); lock the next claim candidate with `for update ... skip locked`; find active claim key for an agent; list ready issues with blocker filtering and priority/number ordering |
| `AgentRepository` | create (duplicate-name translation), find by token hash, find by name, per-agent advisory claim lock (`acquireClaimLock`) |
| `IssueEventRepository` | append one row and return it; list by issue ordered by id |
| `IssueMetaRepository` | batch-load label names and relations for a set of issue ids in at most two statements |
| `LabelRepository` | replace an issue's label set, scoped to its project |
| `RelationRepository` | idempotent insert returning whether a row was created |

Transactions:

- Repositories obtained from `TransactionPorts` are bound to that transaction's
  connection. Only flat transactions exist: no savepoints, no nested
  `transaction` call. A use case that needs two writes composes them at one
  level.
- Order before the transaction: parse and validate input and resolve actor
  context. The status, authority, and ownership checks run on the locked row
  inside the transaction. `moveIssue` follows this today: validation and context
  resolution first, then lock, check, write, append event, and reload inside
  `ports.transaction`.
- The canonical order inside the transaction - lock the row, check status and
  authority again on the locked row, write, append the event, reload the issue
  through the read model, commit - applies to the status- and claim-changing use
  cases: move, submit for review, release claim, claim next, block, unblock.
  Today `moveIssue` runs the full sequence through the ports
  (`lockByKey`, legality and authority checks, `updateStatus`, `append`,
  `hydrateIssue`) inside `src/application/issues.ts`; `submitForReview`,
  `releaseClaim`, `blockIssue`, and `unblockIssue` follow it in
  `src/application/queue.ts` and `src/application/blocking.ts`; and `claimNext`
  in `src/application/queue.ts` runs it in the same shape: `acquireClaimLock`,
  then `lockClaimCandidate`, then the claim write, event append, and reload.
- The other multi-statement use cases take no row lock: create issue runs the
  counter CTE and the insert in one transaction inside `IssueRepository.create`;
  update issue writes through the port and reloads; comment wraps a single event
  append through `IssueEventRepository`; set labels replaces rows; and add
  relation reads before the transaction and inserts idempotently.
- Agent creation is a single insert today (`createAgent` in
  `src/application/agents.ts` through `AgentRepository.create`, no explicit
  transaction). It becomes transactional only if token mint and insert must
  commit together.
- The issue read model presents an issue from its stored record, the resolved
  actor context, and its meta, and computes `allowedTransitions` from the domain
  machine. Derived fields are never persisted: there is no
  `allowed_transitions` column, and `labels`/`relations` stay in their own
  tables.

SQL invariants preserved literally:

| Invariant | Where it lives today |
|---|---|
| Per-project key allocation via a counter CTE (`update projects set next_number = next_number + 1 ... insert into issues ...`) | `IssueRepository.create` in `src/adapters/postgres/repositories/issues.ts` |
| Row lock by key (`select ... from issues where key = $1 for update`) | `IssueRepository.lockByKey` in `src/adapters/postgres/repositories/issues.ts`, used by `moveIssue`, `submitForReview`, `releaseClaim`, `blockIssue`, and `unblockIssue` |
| Candidate selection with `for update of i skip locked` | `IssueRepository.lockClaimCandidate` in `src/adapters/postgres/repositories/issues.ts`, called by `claimNext` in `src/application/queue.ts` |
| Advisory lock keyed by agent: `pg_advisory_xact_lock(727275, hashtext($1))` | `AgentRepository.acquireClaimLock` in `src/adapters/postgres/repositories/agents.ts`, called by `claimNext` in `src/application/queue.ts`; the migration runner in `src/migrate.ts` uses a separate key `727274` (`MIGRATION_LOCK_KEY`) |
| Claim fence: unique partial index `issues_one_active_claim_per_agent` on `(claimed_by)` where `status in (in_progress, in_review)` and `claimed_by is not null` | `migrations/0003_agents.sql` |
| Meta batching: at most two statements, one for labels and one for relations | `IssueMetaRepository.loadForIds` in `src/adapters/postgres/repositories/issue-meta.ts` |
| Listing budget: one row query plus those two meta statements for a non-empty page | `listIssues` in `src/application/issues.ts`; the empty-project existence check is a separate fallback, not part of the hot path |
| Append-only events: trigger `issue_events_append_only` rejects UPDATE and DELETE with SQLSTATE 23001 | `migrations/0002_issues.sql` |
| Change notifications: `pg_notify('issues_changed', project_id)` from triggers on issue insert/update and event insert | `migrations/0005_issue_notifications.sql` |

## 5. Error translation policy

1. Domain failures are `ServiceError` carrying a stable `ERROR_CODES` code
   (`src/domain/errors.ts`). The only other error type that crosses a port is
   the port-level `ActiveClaimConflict`.
2. Each foreign error is translated once per crossing: adapters translate
   persistence and transport errors, use cases translate port errors
   (`ActiveClaimConflict` -> `agent_busy`), and adapters render transport
   responses. Translation happens at the boundary that produced the foreign
   error, never deeper.
3. The Postgres adapter maps SQLSTATE `23505` to `duplicate` where the use case
   treats the unique violation as a duplicate (project key, agent name). It maps
   a violation of `issues_one_active_claim_per_agent` to the port-level
   `ActiveClaimConflict` error. Project-key duplicate translation is implemented
   in `src/adapters/postgres/repositories/projects.ts`, agent-name translation
   in `src/adapters/postgres/repositories/agents.ts`, and the fence translation
   in `src/adapters/postgres/repositories/issues.ts`; no service module
   translates a duplicate.
4. The use case converts `ActiveClaimConflict` into `agent_busy`, naming the
   agent's active key. `moveIssue` and `claimNext` do this today by re-reading
   the active claim after the failure.
5. No pg type, `pgErrorCode`, `pgErrorConstraint`, or constraint-name string
   appears outside `src/adapters/postgres/`. Today `pgErrorConstraint` is
   imported only by `src/adapters/postgres/repositories/issues.ts`;
   `pgErrorCode` only by `src/adapters/postgres/repositories/projects.ts` and
   `src/adapters/postgres/repositories/agents.ts`. No production module outside
   `src/adapters/postgres/` reads either.
6. HTTP status mapping lives only in the HTTP adapter. Today `httpStatusFor` and
   `HTTP_STATUS` live in `src/http/errors.ts`, which `src/http/app.ts` imports;
   target is `src/adapters/http/errors.ts`.
7. Rendering per transport: HTTP returns `{ error: { code, message } }`; MCP
   returns an `isError` text result `"<code>: <message>"` (`errorResult` in
   `src/mcp/tools.ts`); the CLI writes `"<code>: <message>"` to stderr with exit
   code 1, while argv misuse is exit code 2.
8. Validation split. The adapter validates transport shape only: JSON object,
   declared field types, array-of-string, `Content-Type: application/json`, the
   1 MiB body cap, cookie/bearer presence, and webhook signature. The domain
   validates business rules: key formats, title and name lengths, priority
   range, status membership, label normalization, block reason, agent name,
   transition legality, and authority. Adapter checks are pre-filters; the
   domain check remains authoritative even when the adapter already checked.
9. Error codes and messages are API. Changing a message is a behavior change and
   needs the test that pins it updated in the same commit.

Current code-to-HTTP status table (`HTTP_STATUS` in `src/http/errors.ts`):

| Error code | HTTP status |
|---|---|
| `validation` | 400 |
| `not_authenticated` | 401 |
| `forbidden_transition` | 403 |
| `not_found` | 404 |
| `illegal_transition` | 409 |
| `agent_busy` | 409 |
| `no_ready_issue` | 409 |
| `duplicate` | 409 |
| `webhook_not_configured` | 503 |
| any non-`ServiceError` | 500, body `internal` |

## 6. Web layering

Target: four layers importing one way, `ui -> application -> domain` and
`adapters -> application ports + domain`, plus a web composition entrypoint.
`web/src/main.tsx` is the only composition module that imports both `ui` and
`application`, and it renders the app. `ui` is imported only by that entrypoint
and by other ui modules. In the target `app.tsx` is deleted: its orchestration
becomes `web/src/application/workspace.ts`, and the thin ui wiring (imports
workspace and ui, renders once) stays in `web/src/main.tsx`. Today `app.tsx` is
one 786-line module holding auth, loading, refresh, actions, and dialogs.

| Layer | Owns | Forbidden | Target |
|---|---|---|---|
| Domain | `Issue`, `Project`, `IssueEvent`, `ReadyQueue`, `Actor` types; status/priority/event label and tone maps; formatting and filtering rules; pure route parsing and path builders; imports the backend status contract | React, network APIs, adapters, UI, browser storage | `web/src/domain/` |
| Application | API port, realtime port, an application error type, workspace orchestration: auth and session state, project selection, issue/ready/timeline loading, refresh and tick handling, action execution with error mapping | Adapters, UI, React | `web/src/application/` |
| Adapters | `fetch` client implementing the API port; `EventSource` hook implementing the realtime port; history/`popstate` router implementing navigation | UI, direct domain I/O | `web/src/adapters/` |
| UI | React components and styles only; receives data and callbacks | `fetch`, `EventSource`, `history`, adapters, domain I/O | `web/src/ui/` |
| Composition | Mount the app: import the application workspace and the ui components, render once | Business rules, transport, domain I/O | `web/src/main.tsx` |

Rules:

- Target: UI components receive data and callbacks. They do not call `fetch`,
  `EventSource`, `window.history`, or any module that does.
- Orchestration lives in application. A component may own local presentation
  state (an open dialog, a draft string); it must not own loading, refresh, or
  auth sequencing.
- Route parsing and path building are pure domain functions. History writes and
  `popstate` listeners are the history adapter.

Current web state, honestly:

| Layer today | Files | Problem |
|---|---|---|
| Domain-ish | `web/src/lib/types.ts`, `web/src/lib/presentation.ts`, route parsing inside `web/src/lib/router.ts` | `types.ts` is already React-free and imports the backend contract, but route parsing is mixed with React hooks and history in one file |
| Application | `web/src/app.tsx` | One 786-line component holds auth, loading, refresh, actions, toasts, and route-driven dialog state; no port and no application module |
| Adapters | `web/src/lib/api.ts` (fetch), `web/src/lib/events.ts` (EventSource), history calls in `web/src/lib/router.ts` | No ports; `ApiError` is both transport detail and UI-facing error |
| UI | `web/src/components/*.tsx` | Mostly prop-driven, but `SignIn.tsx` and `ProjectSetup.tsx` import `api` from `../lib/api.ts` and call it directly |

Target web tree:

```
web/src/
  domain/        types.ts  presentation.ts  routes.ts
  application/   ports.ts  workspace.ts  errors.ts
  adapters/      api-client.ts  realtime.ts  history.ts
  ui/            components/*.tsx  styles.css
  main.tsx       composition entrypoint: only module importing both application and ui
```

### Comparison with the reference client

`/home/dietkyle/projects/contract-iq/apps/frontend/src` is a prototype, not a
model implementation: many files start with `// @ts-nocheck`, data is mocked, and
several views call transport hooks directly. It is used here only to make the
mapping concrete. The path is machine-local and the comparison is illustrative;
the repository has no dependency on it.

| Reference directory | What it holds | Curved target layer | What the example lacks |
|---|---|---|---|
| `api/` (`client.ts`, `endpoints.ts`, `hooks.ts`, `auth.ts`) | `fetch` wrapper, TanStack Query hooks, auth headers from `localStorage` | Adapters (client) plus application (orchestration behind ports) | No port boundary; hooks are called straight from views; errors collapse to a generic `Error`, so no stable code reaches the UI |
| `components/` | Presentational primitives (badge, button, card, sidebar) | UI | `@ts-nocheck`, no data/callback contract, no separation from page logic |
| `design-system/` | CSS tokens and global styles | UI styling | Tokens only; no component behavior |
| `data/` (`mock.ts`) | Fixture records exported as production code | No counterpart | No domain types; fixtures live in the app tree |
| `lib/` (`cn`, `formatCurrency`, `daysUntil`) | Pure formatting helpers | Web domain | No status contract, no route parsing, no filtering rules |
| `routes/` and `views/` | Page components; views import `api/hooks` | UI pages | Transport inside views; `currentView` navigation comes from state, not a parsed URL |
| `stores/` (zustand) | `sidebarOpen`, `currentView` | Application/UI state | Navigation state in a store instead of route parsing |
| `__tests__/` | Smoke tests | Testing policy for the web domain, if added | Covered by neither layer definition nor a port |

## 7. Testing policy

Tests prove exterior behavior. They call the seam an end user or agent hits, not
a private function, not SQL text, not the module graph.

The existing suites are the regression contract: 189 tests in 16 files under
`test/`, run by `npm test` (`node --test --test-concurrency=1 test/*.test.ts`).
They need the Postgres from `docker compose` on port 55432: `bash scripts/db.sh`
bootstraps it, and `test/helpers/db.ts` refuses any database whose name does not
start with `curved_test`.

The migration may update imports and setup in those files; it may not weaken an
assertion or delete a case to make a move pass. If a rule moves, its test moves
with it and keeps asserting the same code, message, or state.

| Seam | Files today | What it proves |
|---|---|---|
| Application use cases against a real Postgres test database | `test/transitions.test.ts`, `test/issues.test.ts`, `test/agents.test.ts` (claim and queue cases), `test/blocking.test.ts`, `test/comments.test.ts`, `test/labels.test.ts`, `test/relations.test.ts`, `test/events.test.ts`, `test/projects.test.ts` (use cases, plus the transaction-scoped ports commit/rollback and repository find-by-key cases); setup via `openTestDatabase` in `test/helpers/db.ts` (creates `curved_test*`, applies migrations) | Transition graph and actor authority, claim fence, claim-column transitions, event appends, error codes and messages |
| HTTP routes against the built app | `test/http.test.ts` constructs `createApp` and calls `app.handle` with real `Request` objects; its SPA fallback cases construct their own `createApp` with a fixture `webDistDir`. `test/github.test.ts` also belongs here: it imports `createApp` and drives webhook cases through it; only its three pure-helper cases and the `applyPullRequestEvent` guard case that also bypasses HTTP do not | Status codes, auth (UI bearer, session cookie, `crv_` agent bearer), payload shapes, no-CORS and JSON rules, SPA serving and 503, webhook signature and event mapping |
| SSE and the event hub | `test/sse.test.ts`, `test/event-hub.test.ts` with a real hub against Postgres | `ready`/`issues_changed`/`ping` frames, cookie-only stream auth, one LISTEN client shared by subscribers, subscription release on cancel |
| Spawned CLI | `test/cli.test.ts` runs `node src/cli.ts` as a child process | argv parsing, output, exit codes, agent token handling |
| Spawned MCP stdio process | `test/mcp.test.ts` runs `src/mcp/main.ts` through `StdioClientTransport` | Tool schemas, agent resolution from `CURVED_AGENT_TOKEN`, results and error results |
| Raw-SQL invariant proofs | `test/events.test.ts` and `test/comments.test.ts` assert SQLSTATE `23001` on UPDATE and DELETE of `issue_events`; `test/migrate.test.ts` proves concurrent migration runs apply each file once | Database-enforced invariants that no TypeScript test can prove |

Additional rules:

- No new implementation-detail tests: do not assert that a helper exists, that a
  function has a particular statement count, or that a module imports another
  module. The planned architecture check covers import direction; it is not a
  substitute for a behavior test. The one named exception is the existing
  query-budget assertion in `test/labels.test.ts` (three statements for a
  listing page, SQL text filtered for `issue_labels` and `issue_relations`): the
  budget is part of the contract, so it stays and must not be weakened, but it
  is not a substitute for behavior coverage.
- Do not replace the real database with a mock. The SQL invariants are the
  product.
- Every new rule (a new edge, a new fence, a new claim rule) needs a test at the
  seam an agent or human actually uses, which fails without the change.
- The architecture check described in section 9 is planned and does not exist
  yet. Do not cite it as current coverage.

Web testing today: there is no unit test framework for the SPA (no web test
script, no DOM test runner). Current evidence is `npm run check` (typecheck plus
189 tests), `npm run build` (`npm run typecheck` then `npm run build:web`, a
`vite build`), and a browser pass at 390x844 and desktop. This is a known
constraint: web formatting, filtering, and route parsing have no automated proof
today. When a web runner is added, the pure web domain (status maps, filters,
sorting, route parsing) is the first target, not component snapshots.

## 8. Review checklist

For a new module or a moved one:

- [ ] Which layer is this? Does its path match the layer map in section 1?
- [ ] Does it import only inward (domain imports nothing; application imports
      domain and ports; adapters import domain, application ports and use cases,
      and only the sanctioned peer set `http` -> `github`, `sse`, `static`)?
- [ ] Is any rule from section 2 duplicated here: an enum, a regex, a transition
      edge, an authority check, a default?
- [ ] Are foreign errors translated exactly once, at this boundary, with no pg
      shape leaking inward?
- [ ] Is the transaction boundary right? N/A when the use case takes no row lock;
      otherwise multi-statement or lock-dependent work in one transaction, flat,
      ordered lock -> check -> write -> append event -> reload.
- [ ] Is the new behavior proven at an exterior seam in `test/`, and does the
      proof fail without the change?
- [ ] Is the web component presentational: data in props, callbacks out, no
      `fetch`, `EventSource`, or `history`?
- [ ] Is this a second convention (a new suffix, a new error class, a new ports
      module, a new SQL helper) where one already exists?
- [ ] Does the change keep `npm run check` green without weakening an assertion?
- [ ] Is any target-state rule written as if it were current?

## 9. Enforcement

`npm run check` is the normal gate. It runs `npm run typecheck` (server and web
configs) and `npm test` (189 tests). `./scripts/init.sh` runs install, database
(`bash scripts/db.sh`), check, then build; `--no-install` skips only install.
`./scripts/clean-state.sh` is the end-of-session gate.

An import-direction check is planned and DOES NOT exist yet. No script or test
enforces layering today. It will be wired into `npm run check`, and it will
forbid exactly these directions:

| From | Forbidden imports |
|---|---|
| `src/domain/**` | `src/application/**`, `src/adapters/**`, `src/composition/**`, `pg`, `node:*`, `react`, `react-dom` |
| `src/application/**` | `src/adapters/**`, `src/composition/**`, `pg`, `node:http`, `node:fs` |
| `src/adapters/**` | `src/composition/**`, and any peer adapter outside the sanctioned set `http` -> `github`, `sse`, `static` |
| anything under `src/**` outside `src/adapters/postgres/**` | `pg` |
| `web/src/**` | every backend module except `src/domain/status.ts`, so `src/services/**` is forbidden |
| `web/src/domain/**` | `react`, `react-dom`, `web/src/adapters/**`, `web/src/application/**`, `web/src/ui/**` |
| `web/src/application/**` | `web/src/adapters/**`, `web/src/ui/**` |
| `web/src/ui/**` | `web/src/adapters/**` |
| `web/src/adapters/**` | `web/src/ui/**` |

The `pg` rule is scoped to production code under `src/**`. Tests in `test/`
import `pg` and the pg error helpers today; after step 3 the pg-error
assertions (six sites across four test files, four of them SQLSTATE `23001`)
move to the Postgres adapter's exported helpers or assert `error.code`, and the
check does not apply to `test/`.

These are post-migration paths: the check enforces the target tree, which only
exists after step 4 and step 5 of section 3. Until it lands at step 6, layering
is review-only.

Dual-role files today, classified so review can apply the right layer:

| Path | Today | Becomes |
|---|---|---|
| `src/cli.ts` | Adapter plus composition entrypoint (`withDatabase`) | `src/adapters/cli/` plus `src/composition/cli.ts` |
| `src/mcp/server.ts` | Adapter plus composition entrypoint (`main`) | `src/adapters/mcp/` plus `src/composition/mcp.ts` |
| `src/server.ts` | Composition, plus the Node bridge | `src/composition/server.ts` plus `src/adapters/http/transport.ts` |
| `src/db.ts` | Outbound adapter (pool, pg error helpers) | `src/adapters/postgres/` |
| `src/http/app.ts` | Inbound adapter | `src/adapters/http/` |
| `web/src/main.tsx` | Web composition entrypoint | unchanged |
| `web/src/app.tsx` | Application orchestration, no ports yet | Deleted: orchestration to `web/src/application/workspace.ts`; `web/src/main.tsx` keeps the thin ui wiring |

A dual-role file is exempt from the direction check until its own step; review
judges it by the layer of the code being touched.

Composition roots are exempt by construction: `src/composition/**` may import any
inward layer, and that is the only place allowed to read `process.env` and
construct a pool.

Two limits worth stating rather than hiding:

- Import direction does not detect a duplicated rule (a copied enum, a second
  regex). Those stay review items unless the check later grows a
  symbol-declaration scan.
- Browser globals (`fetch`, `EventSource`, `history`) are not imports, so the "UI
  receives data and callbacks" rule is enforced by review and by the web
  application ports until a lint rule covers them.
