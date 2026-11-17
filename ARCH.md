# Architecture contract

Where code lives in `curved`, what may import what, and which module owns each
rule. Read this before adding a module or moving one.

The migration in section 3 is complete: all seven steps are done, ending with
web layering (LAS-175), the import-direction gate (LAS-174), and the completion
gate (LAS-176). `src/` and `web/src/` are both in their final layouts: every
path named below as a home exists today, and section 9's check enforces the
import rules on it. LAS-176 closed the refactor on 2026-11-17 by re-running the
baseline and clean-state gates, the 195-test suite, the architecture check over
74 files, and real entry-point smoke tests, with no observable product behavior
change; section 10 records that evidence. No path or layer in this file is
described as future work.

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

| Layer | Owns | May import | Home |
|---|---|---|---|
| Domain | Pure rules and types: status contract, transition graph, actor matrix, claim policy, validation, key parsing, domain errors, shared record types | Nothing but TypeScript and other domain modules | `src/domain/` (`status.ts`, `transition.ts`, `actors.ts`, `claim.ts`, `move-policy.ts`, `validation.ts`, `keys.ts`, `errors.ts`, `types.ts`) |
| Application | Use cases, ports, transaction boundaries, authorization sequencing, error translation policy, the issue read model, the `EventHub` port | Domain and its own ports | `src/application/` (`ports.ts`, `projects.ts`, `issues.ts`, `issue-read-model.ts`, `agents.ts`, `queue.ts`, `blocking.ts`, `comments.ts`, `labels.ts`, `relations.ts`, `github.ts`) |
| Outbound adapters | Implement ports: Postgres repositories, the pool and pg error helpers, the migration runner, the LISTEN event hub, token codec, constant-time comparison | Domain; application (ports and use cases) | `src/adapters/postgres/` (`ports.ts`, `pool.ts`, `migrate.ts`, `event-hub.ts`, `repositories/`: `projects.ts`, `issues.ts`, `issue-events.ts`, `issue-meta.ts`, `agents.ts`, `labels.ts`, `relations.ts`), `src/adapters/token-codec.ts`, `src/adapters/timing-safe.ts` |
| Inbound adapters | Translate external formats: HTTP routing plus cookies, the Node request/response bridge, MCP schemas plus results, CLI argv plus output, GitHub signature verification, SSE frames, static SPA files | Domain; application (ports and use cases); sanctioned peer adapters only | `src/adapters/http/` (`app.ts`, `transport.ts`, `auth.ts`, `errors.ts`, `webhook.ts`), `src/adapters/mcp/` (`server.ts`, `tools.ts`), `src/adapters/cli/cli.ts`, `src/adapters/github/` (`signature.ts`, `payload.ts`), `src/adapters/sse/stream.ts`, `src/adapters/static/spa.ts` |
| Composition roots | Read environment, create the pool and the event hub, construct adapters, wire ports into use cases, own shutdown | Everything inward | `src/composition/` (`config.ts`, `server.ts`, `cli.ts`, `mcp.ts`, `migrate.ts`) |

Server tree:

```
src/
  domain/                 status.ts  transition.ts  actors.ts  claim.ts
                          move-policy.ts  validation.ts  keys.ts  errors.ts
                          types.ts
  application/
    ports.ts              ProjectRepository, IssueRepository, IssueEventRepository,
                          IssueMetaRepository, AgentRepository, LabelRepository,
                          RelationRepository, TokenCodec, EventHub, Ports,
                          TransactionPorts, ActiveClaimConflict
    projects.ts  issues.ts  issue-read-model.ts  agents.ts  queue.ts
    comments.ts  blocking.ts  labels.ts  relations.ts  github.ts
  adapters/
    postgres/             ports.ts  pool.ts  migrate.ts  event-hub.ts
                          repositories/*.ts
    token-codec.ts        timing-safe.ts
    http/                 app.ts  transport.ts  auth.ts  errors.ts
                          webhook.ts
    mcp/                  server.ts  tools.ts
    cli/                  cli.ts
    github/               signature.ts  payload.ts
    sse/                  stream.ts
    static/               spa.ts
  composition/            config.ts  server.ts  cli.ts  mcp.ts  migrate.ts
```

Adjacent transfers are disambiguated explicitly:

- `src/adapters/http/transport.ts` owns the Node request/response bridge
  (`toRequest`, `writeResponse`, `streamEventStream`) plus
  `createNodeServer(app)`; `src/composition/server.ts` only wires it.
- `src/adapters/postgres/migrate.ts` owns the migration runner, the ledger SQL,
  and `MIGRATION_LOCK_KEY` (727274), exporting
  `runMigrations({ databaseUrl, migrationsDir? })`. It never reads config.
  `src/composition/migrate.ts` is only the process entrypoint: load config, call
  the runner, print `applied <version>` lines or `already up to date`, set the
  exit code.
- `src/adapters/postgres/ports.ts` owns the `bindPorts` per-transaction factory
  and the `createPorts` aggregate factory; `src/adapters/postgres/pool.ts` owns
  the pool, `Db`/`Database`/`createDatabase`, and `pgErrorCode`/
  `pgErrorConstraint`.

The split between inbound HTTP and GitHub/SSE/static adapters is about format
ownership, not process boundaries: `src/adapters/http/app.ts` calls
`handleGithubWebhook`, `createEventStreamResponse`, and `serveSpa` directly. That
call is the only sanctioned adapter-to-adapter direction; the set is exactly
`http` -> `github`, `sse`, `static`. No adapter may import any other peer
adapter; the HTTP layer never reaches into Postgres, MCP, or CLI. Root-level
`src/adapters/*.ts` files (`token-codec.ts`, `timing-safe.ts`) are shared
utilities, not adapters: any adapter may import them.

### Composition root rule

A composition root is the only place allowed to:

- read environment configuration (`loadConfig`, `.env`, `process.env`);
- create the database pool and any long-lived client (the hub's `LISTEN`
  client);
- construct adapters and pass ports into use cases;
- own shutdown and signal handling (`SIGINT`/`SIGTERM`, `hub.close()`,
  `server.close()`, `db.close()`).

A composition root contains no business rules: no validation beyond refusing to
start with a missing required secret, no status logic, no SQL, no error
translation. `src/composition/server.ts` reads config, requires
`CURVED_UI_TOKEN`, and shuts down in that order: hub, then server, then pool.
`src/composition/cli.ts` and `src/composition/mcp.ts` each open and close their
own pool. `src/composition/config.ts` holds `loadConfig`; it is imported by the
composition entrypoints and by the `test/` helper, never by an adapter or use
case.

## 2. Where the rules live, and no second copy

Each rule has exactly one owning module. The table names the owner and the only
mirror that is allowed. Since step 2, and through LAS-174, each domain rule is
defined once, at the path shown; the deleted `src/services/` left no second
definition anywhere.

| Rule | Owner | Allowed mirror |
|---|---|---|
| Status, priority, event-kind, and actor-type contract; `isStatus`, `isPriority`, `isActorType`; `DEFAULT_STATUS`, `DEFAULT_PRIORITY` | `src/domain/status.ts` | Postgres CHECK constraints |
| Legal transition graph `TRANSITIONS`, `LEGAL_EDGES`, `isLegalTransition` | `src/domain/transition.ts` | None |
| Actor matrix `ACTOR_TRANSITIONS`, `actorMayTransition` | `src/domain/actors.ts` | None |
| Actor-context resolution: `resolveContext`, `validateActor`, deriving whether an agent owns the active claim | `src/domain/actors.ts` | None |
| Shared domain types `Issue`, `Project`, `Agent`, `CreatedAgent`, `IssueEvent`, `IssueMeta`, `IssueRelations`, `emptyMeta` | `src/domain/types.ts` | None |
| `allowedTransitions` and `TransitionContext` | `src/domain/actors.ts` | None; the SPA reads `allowedTransitions` from the payload and never recomputes it |
| Move authority (`mayMove`) | `src/domain/move-policy.ts` | None |
| Claim-column policy (`nextClaimedBy`: clear on `todo`/`backlog`, set by an agent claim, keep otherwise) | `src/domain/claim.ts` | None |
| One active issue per agent (the fence) | `src/domain/claim.ts` states the policy; the use case maps the conflict | partial unique index `issues_one_active_claim_per_agent` (`migrations/0003_agents.sql`), plus the translation to `ActiveClaimConflict` in `src/adapters/postgres/repositories/issues.ts`, its mapping in `src/application/issues.ts`, and the mapping in `src/application/queue.ts` |
| Validation: project key and name, issue title/priority/status, label normalization, block reason, agent name, and their max-length constants | `src/domain/validation.ts` | Postgres CHECK constraints; adapter shape checks |
| Key parsing and normalization: `parseIssueKey`, `issueKeyFromText`, `branchNameForIssue` | `src/domain/keys.ts` | None; adapter regexes must import these |
| Domain errors `ServiceError`, `ERROR_CODES` | `src/domain/errors.ts` | None; HTTP status mapping is adapter-only, in `src/adapters/http/errors.ts` |
| Issue read model: project a stored row plus actor context plus meta, derive `allowedTransitions` | `src/application/issue-read-model.ts` (`toIssue`, `hydrateIssue`) | None |

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
  `PROJECT_KEY_PATTERN` and `ISSUE_KEY_PATTERN` in what is now
  `src/adapters/mcp/tools.ts` (zod schemas),
  `ISSUE_KEY_PATTERN`/`PROJECT_KEY_PATTERN` in the deleted
  `src/services/issues.ts`, `KEY_PATTERN` in the deleted
  `src/services/projects.ts`, and `ISSUE_KEY_IN_TEXT` in the deleted
  `src/services/github.ts` (its use case is now `src/application/github.ts`,
  which imports `issueKeyFromText`). Each site imported from
  `src/domain/keys.ts` while it existed; a future adapter that needs a key
  format imports it too and never declares its own.

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
  `web/src/domain/types.ts` imports `ActorType`, `EventKind`, `Priority`, and
  `Status` from `src/domain/status.ts` and re-exports them, and
  `web/src/domain/presentation.ts` imports `STATUSES` for ordering. Presentation
  maps (`STATUS_LABEL`, `STATUS_TONE`, `PRIORITY_LABEL`, `EVENT_LABEL`) are
  display data, not a copy of the contract, and are allowed in the web domain.
  The allowlist is the limit: the only backend module a web module may import
  is `src/domain/status.ts`. Importing any other backend module is forbidden.
- **Adapter pre-filters.** MCP zod schemas and HTTP field checks may restate a
  numeric bound to produce a fast, well-shaped error at the edge. They may not
  restate a pattern: a zod schema or adapter check that needs a key or name
  format imports the domain regex constant. They are pre-filters either way: the
  domain re-validates, and the adapter must call the domain function rather than
  own a competing regex.
- Anything outside those three cases (a hand-maintained enum copy, a second
  transition table, a duplicated authority check) is a defect, not a mirror.

## 3. Current state and migration path

All seven steps are done. The pure rules live in `src/domain/`, every resource
runs through application use cases over ports, the inbound adapters and
composition roots are in place, and `web/src` is layered. `src/services/`,
`src/db.ts`, `src/config.ts`, `src/migrate.ts`, `src/server.ts`, `src/cli.ts`,
`src/http/`, `src/mcp/`, `web/src/app.tsx`, `web/src/lib/`, and
`web/src/components/` no longer exist, with no re-export shims.

Completed path mapping:

| Deleted path | Replaced by |
|---|---|
| `src/db.ts` | `src/adapters/postgres/pool.ts` (pool, transactions, `pgErrorCode`, `pgErrorConstraint`) plus `src/adapters/postgres/ports.ts` |
| `src/config.ts` | `src/composition/config.ts` (`loadConfig`, `Config`) |
| `src/migrate.ts` | `src/adapters/postgres/migrate.ts` (runner, ledger SQL, lock) plus `src/composition/migrate.ts` (entrypoint) |
| `src/server.ts` | `src/composition/server.ts` plus `src/adapters/http/transport.ts` |
| `src/cli.ts` | `src/adapters/cli/cli.ts` plus `src/composition/cli.ts` |
| `src/mcp/` | `src/adapters/mcp/` plus `src/composition/mcp.ts` |
| `src/http/` | `src/adapters/http/`, the signature and payload split into `src/adapters/github/`, frames and SPA serving into `src/adapters/sse/` and `src/adapters/static/`, and the hub's `pg.Client` into `src/adapters/postgres/event-hub.ts` |
| `src/services/` | `src/application/` (use cases) plus `src/adapters/postgres/repositories/` (SQL), landed in LAS-170 to LAS-173 |
| old root error module | `src/domain/errors.ts` plus the HTTP mapping in `src/adapters/http/errors.ts` |
| old shared status module | split into `src/domain/status.ts`, `src/domain/transition.ts`, and `src/domain/actors.ts` |

The migration was expand-contract, one step per work item:

| Step | Work | Exit criterion |
|---|---|---|
| 1. Codify | Done: this file, a rule inventory, the existing suite green | Met: every rule in section 2 has one named owner |
| 2. Extract domain | Done (LAS-169, 2026-11-17): created `src/domain/`, moved the pure rules, made the services import them | Met: no domain rule remained defined outside `src/domain/`; tests changed only their import paths |
| 3. Ports and Postgres | Done (LAS-170 to LAS-173, 2026-11-17): ports module, project, issue, agent, label, and relation repositories, the issue read model, and every resource use case; `src/services/` deleted | Met: every resource sits behind ports and `createApp` takes no `db`; the last item, event-hub construction, moved to `src/composition/server.ts` in step 4 (LAS-174) |
| 4. Rewire inbound adapters, delete old modules | Done (LAS-174, 2026-11-17): HTTP, MCP, CLI, GitHub, SSE, static moved under `src/adapters/`; `src/composition/` added; `src/db.ts`, `src/config.ts`, `src/migrate.ts`, `src/server.ts`, `src/cli.ts`, `src/http/`, and `src/mcp/` deleted; event-hub construction moved to `src/composition/server.ts` | Met: no import of a deleted path; behavior unchanged; the suite green |
| 5. Web layering | Done (LAS-175, 2026-11-17): `web/src` split into `domain/`, `application/`, `adapters/`, and `ui/`; orchestration moved out of `app.tsx` into `web/src/application/workspace.ts`; `api` imports removed from components; `web/src/app.tsx`, `web/src/lib/`, `web/src/components/`, and `web/src/styles.css` deleted | Met: typecheck and build green; components import no transport; no module imports `web/src/lib/`; 195 tests green; browser pass at 390x844 and desktop |
| 6. Completion gate | Done (LAS-174, 2026-11-17): `scripts/check-architecture.mjs` and `npm run check:arch`, wired into `npm run check`, with five failing fixture trees | Met: `npm run check` green with no undocumented exception |
| 7. Completion gate | Done (LAS-176, 2026-11-17): baseline and clean-state gates, 195 tests, `architecture: ok (74 files)`, CLI, MCP stdio with a real agent token, HTTP+SSE in Chromium at 1440x900 and 390x844 with cross-tab updates and reconnect, the GitHub webhook through the HTTP app, and the built SPA served by the HTTP process | Met: every acceptance item verified; no unrecorded behavior difference |

Step 4's rewiring was mechanical: adapter import paths changed, `createApp`
takes `{ ports, events, uiToken, ... }` where `events` is an injected
`EventHub`, tests create a real hub and close it, and CLI/MCP spawns target
`src/composition/cli.ts` and `src/composition/mcp.ts`. No assertion changed.
The only user-visible text change was the MCP "no agent token" hint, which now
names `node src/composition/cli.ts agent add <name>`; no test pinned the old
path.

Rules that hold for every move, and for every change after them:

- A refactor never changes behavior. Public function names and input shapes
  stay where callers and tests depend on them; error codes and messages stay
  identical; HTTP bodies and statuses stay identical.
- No re-export shims and no dual conventions. A transitional re-export is
  allowed only inside the single work item that moves a symbol, and it is
  deleted before that work item ends. There is one spelling per path and one
  convention per concern. A module importing both an old and a new location is a
  defect.

## 4. Ports and transactions

Ports are declared in `src/application/ports.ts` and implemented in
`src/adapters/postgres/`. Every resource port exists: projects, issues, events,
meta, agents, labels, relations, and tokens. The Postgres executor, pool, and pg
error helpers live in `src/adapters/postgres/pool.ts`; repositories take a `Db`
executor from it. `src/application/ports.ts` also declares `EventHub`
(`subscribe`, `stats`, `close`): it is not part of `Ports` or
`TransactionPorts`, `src/adapters/postgres/event-hub.ts` implements it, and
`src/composition/server.ts` creates it, injects it into `createApp`, and closes
it during shutdown before the server and the pool.

- One ports module: `src/application/ports.ts`. It also declares the port-level
  `ActiveClaimConflict` error, alongside `Ports` and `TransactionPorts`; every
  port it declares is implemented.
- Naming convention: `<Noun>Repository` for persistence, `TokenCodec` for token
  mint/verify, `EventHub` for the LISTEN fan-out. No `Service`, `Gateway`,
  `Provider`, or `Manager` suffix.
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

Repository bindings: `bindPorts(db)` in `src/adapters/postgres/ports.ts` binds
the repositories to a given executor, and `createPorts(database)` delegates to
it, binding to the pool or, inside `transaction(fn)`, to the transaction's
connection. With no `transaction` member on `TransactionPorts`, a nested
transaction cannot type-check. The `EventHub` is not created there: only the
composition root knows the database URL for its own `LISTEN` client.

The landed ports are `ProjectRepository` (create, list, findByKey),
`IssueRepository` (create with allocation, findById, findByKey, lockByKey, list,
updateFields, updateStatus, block, unblock, lockClaimCandidate,
findActiveClaimKey, listReady), `IssueEventRepository` (append, list),
`IssueMetaRepository` (loadForIds), `AgentRepository` (create, findByTokenHash,
findByName, acquireClaimLock), `LabelRepository` (replace), `RelationRepository`
(add), `TokenCodec` (mint, hash), and `EventHub` (subscribe, stats, close).

Repository inventories:

| Repository | Operations |
|---|---|
| `ProjectRepository` | create (duplicate-key translation), list ordered by key, find by key |
| `IssueRepository` | create with atomic per-project number allocation; find by id; find by key; lock by key; list with project and status filters ordered by project then number; update mutable fields; update status and claim column; block in one statement (status `todo`, claim cleared, reason recorded); unblock in one statement (reason cleared, status and claim untouched); lock the next claim candidate with `for update ... skip locked`; find active claim key for an agent; list ready issues with blocker filtering and priority/number ordering |
| `AgentRepository` | create (duplicate-name translation), find by token hash, find by name, per-agent advisory claim lock (`acquireClaimLock`) |
| `IssueEventRepository` | append one row and return it; list by issue ordered by id |
| `IssueMetaRepository` | batch-load label names and relations for a set of issue ids in at most two statements |
| `LabelRepository` | replace an issue's label set, scoped to its project (upsert the project's labels by name, then replace the set) |
| `RelationRepository` | add a blocking edge idempotently, returning true only when a row was created |
| `EventHub` | subscribe a listener and return its release; report subscriber and client counts; close the `LISTEN` client |

Transactions:

- Repositories obtained from `TransactionPorts` are bound to that transaction's
  connection. Only flat transactions exist: no savepoints, no nested
  `transaction` call. A use case that needs two writes composes them at one
  level.
- Order before the transaction: parse and validate input and resolve actor
  context. The status, authority, and ownership checks run on the locked row
  inside the transaction. `moveIssue` follows this: validation and context
  resolution first, then lock, check, write, append event, and reload inside
  `ports.transaction`.
- The canonical order inside the transaction - lock the row, check status and
  authority again on the locked row, write, append the event, reload the issue
  through the read model, commit - applies to the status- and claim-changing use
  cases: move, submit for review, release claim, claim next, block, unblock.
  `moveIssue` runs it in `src/application/issues.ts`; `submitForReview`,
  `releaseClaim`, `blockIssue`, and `unblockIssue` follow it in
  `src/application/queue.ts` and `src/application/blocking.ts`; and `claimNext`
  in `src/application/queue.ts` runs it in the same shape: `acquireClaimLock`,
  then `lockClaimCandidate`, then the claim write, event append, and reload.
- The other multi-statement use cases take no row lock: create issue runs the
  counter CTE and the insert in one transaction inside `IssueRepository.create`;
  update issue writes through the port and reloads; comment wraps a single event
  append through `IssueEventRepository`; set labels finds the issue inside a
  transaction, replaces the rows, and appends one `labels` event; and add
  relation resolves both issues before the transaction, inserts idempotently,
  and appends a `relation` event only when a row was created.
- Agent creation is a single insert (`createAgent` in
  `src/application/agents.ts` through `AgentRepository.create`, no explicit
  transaction). It becomes transactional only if token mint and insert must
  commit together.
- The issue read model presents an issue from its stored record, the resolved
  actor context, and its meta, and computes `allowedTransitions` from the domain
  machine. Derived fields are never persisted: there is no
  `allowed_transitions` column, and `labels`/`relations` stay in their own
  tables.

SQL invariants preserved literally:

| Invariant | Where it lives |
|---|---|
| Per-project key allocation via a counter CTE (`update projects set next_number = next_number + 1 ... insert into issues ...`) | `IssueRepository.create` in `src/adapters/postgres/repositories/issues.ts` |
| Row lock by key (`select ... from issues where key = $1 for update`) | `IssueRepository.lockByKey` in `src/adapters/postgres/repositories/issues.ts`, used by `moveIssue`, `submitForReview`, `releaseClaim`, `blockIssue`, and `unblockIssue` |
| Candidate selection with `for update of i skip locked` | `IssueRepository.lockClaimCandidate` in `src/adapters/postgres/repositories/issues.ts`, called by `claimNext` in `src/application/queue.ts` |
| Advisory lock keyed by agent: `pg_advisory_xact_lock(727275, hashtext($1))` | `AgentRepository.acquireClaimLock` in `src/adapters/postgres/repositories/agents.ts`, called by `claimNext` in `src/application/queue.ts` |
| Migration lock: `pg_advisory_lock(727274)` shared by every runner against one database | `src/adapters/postgres/migrate.ts` (`MIGRATION_LOCK_KEY`) |
| Claim fence: unique partial index `issues_one_active_claim_per_agent` on `(claimed_by)` where `status in (in_progress, in_review)` and `claimed_by is not null` | `migrations/0003_agents.sql` |
| Meta batching: at most two statements, one for labels and one for relations | `IssueMetaRepository.loadForIds` in `src/adapters/postgres/repositories/issue-meta.ts` |
| Listing budget: one row query plus those two meta statements for a non-empty page | `listIssues` in `src/application/issues.ts`; the empty-project existence check is a separate fallback, not part of the hot path |
| Append-only events: trigger `issue_events_append_only` rejects UPDATE and DELETE with SQLSTATE 23001 | `migrations/0002_issues.sql` |
| Change notifications: `pg_notify('issues_changed', project_id)` from triggers on issue insert/update and event insert | `migrations/0005_issue_notifications.sql`; consumed by `src/adapters/postgres/event-hub.ts` (`ISSUES_CHANGED_CHANNEL`, one lazily opened `pg.Client` per hub, reconnect once after 1s while subscribers remain) |

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
   in `src/adapters/postgres/repositories/issues.ts`.
4. The use case converts `ActiveClaimConflict` into `agent_busy`, naming the
   agent's active key. `moveIssue` and `claimNext` do this by re-reading the
   active claim after the failure.
5. No pg type, `pgErrorCode`, `pgErrorConstraint`, or constraint-name string is
   used by production code outside `src/adapters/postgres/`. Both helpers are
   declared in `src/adapters/postgres/pool.ts`; `pgErrorConstraint` is imported
   only by `src/adapters/postgres/repositories/issues.ts`, and `pgErrorCode`
   only by `src/adapters/postgres/repositories/projects.ts` and
   `src/adapters/postgres/repositories/agents.ts`. Tests import both from
   `src/adapters/postgres/pool.ts`.
6. HTTP status mapping lives only in the HTTP adapter: `httpStatusFor` and
   `HTTP_STATUS` are in `src/adapters/http/errors.ts`, which
   `src/adapters/http/app.ts` imports, alongside `errorBody`.
7. Rendering per transport: HTTP returns `{ error: { code, message } }`; MCP
   returns an `isError` text result `"<code>: <message>"` (`errorResult` in
   `src/adapters/mcp/tools.ts`); the CLI writes `"<code>: <message>"` to stderr
   with exit code 1, while argv misuse is exit code 2
   (`src/adapters/cli/cli.ts`). `src/composition/migrate.ts` prints the runner's
   `ServiceError` as `"<code>: <message>"` and sets exit code 1; it does no
   translation of its own.
8. Validation split. The adapter validates transport shape only: JSON object,
   declared field types, array-of-string, `Content-Type: application/json`, the
   1 MiB body cap, cookie/bearer presence, and webhook signature. The domain
   validates business rules: key formats, title and name lengths, priority
   range, status membership, label normalization, block reason, agent name,
   transition legality, and authority. Adapter checks are pre-filters; the
   domain check remains authoritative even when the adapter already checked.
9. Error codes and messages are API. Changing a message is a behavior change and
   needs the test that pins it updated in the same commit. The refactor kept
   every code and message; the one intentional text change was the MCP "no agent
   token" hint path, and no test pinned the old path.

HTTP status table (`HTTP_STATUS` in `src/adapters/http/errors.ts`):

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

The web client is layered: four layers importing one way,
`ui -> application -> domain` and
`adapters -> application ports and errors + domain`, plus the composition
entrypoint. `web/src/main.tsx` is the only module that imports both `ui` and
`application`, and the only one that wires adapters: it creates the fetch
client, calls the history and realtime adapter hooks, injects the three ports
into `useWorkspace`, and renders `AppView`. `ui` is imported only by that
entrypoint and by other ui modules. `web/src/app.tsx`, `web/src/lib/`, and
`web/src/components/` are deleted with no shims; the old 786-line `app.tsx`
became `web/src/application/workspace.ts` (orchestration) plus
`web/src/ui/AppView.tsx` (rendering).

| Layer | Owns | Forbidden | Home |
|---|---|---|---|
| Domain | `Issue`, `Project`, `IssueEvent`, `ReadyQueue`, `Actor`, `IssueTimeline`, `ProjectList`, `NewIssueInput`, `ToastKind`, and `ToastItem` types; status/priority/event label and tone maps; `STATUS_ORDER`; formatting and filtering rules (`initials`, `matchesQuery`, `sortForColumn`, `countByStatus`, `relativeTime`, `absoluteTime`, `eventDetail`); pure route parsing and path builders; imports the backend status contract | React, network APIs (`fetch`, `EventSource`), `history`/`window`, adapters, application, UI, browser storage, any backend module except `src/domain/status.ts` | `web/src/domain/` (`types.ts`, `presentation.ts`, `routes.ts`) |
| Application | `ApiPort`, `RealtimePort`, `NavigationPort`, and `IssuesChangedOptions`; `ApplicationError` and its guards; `useWorkspace` orchestration: auth and session state, project selection, issue/ready/timeline loading, refresh and tick handling, action execution with error mapping, the Ctrl/Cmd+K listener | Adapters, UI, JSX or components, `fetch`, `EventSource`, history writes, backend modules. It may import React hooks (`react` state, effect, memo, callback) but renders nothing | `web/src/application/` (`ports.ts`, `errors.ts`, `workspace.ts`) |
| Adapters | `createApiClient(): ApiPort` over `fetch`; `useIssuesChanged` and `realtime: RealtimePort` over one `EventSource`; `useHistoryRouter(): NavigationPort` over `pushState`/`replaceState`/`popstate` | UI, domain I/O; application modules other than `ports.ts` and `errors.ts` | `web/src/adapters/` (`api-client.ts`, `realtime.ts`, `history.ts`) |
| UI | React components and styles only; receives data and callbacks | `fetch`, `EventSource`, `history`, adapters, domain I/O | `web/src/ui/` (`AppView.tsx`, `Boot.tsx`, `Board.tsx`, `CommandPalette.tsx`, `Dialog.tsx`, `IssueDetail.tsx`, `Modal.tsx`, `NewIssueDialog.tsx`, `ProjectSetup.tsx`, `Queue.tsx`, `Shell.tsx`, `SignIn.tsx`, `Toasts.tsx`, `ui.tsx`, `styles.css`) |
| Composition | Mount the app: wire the adapters, call the history and realtime hooks, inject the three ports into `useWorkspace`, render `AppView` | Business rules, transport, domain I/O | `web/src/main.tsx` |

Adapters translate transport into the application vocabulary: `api-client.ts`
turns a network failure into `ApplicationError(0, "network", ...)` and a non-ok
response into `ApplicationError(status, code, message)`; `realtime.ts` filters
`issues_changed` frames by project id and reconnects after 1s; `history.ts` owns
`pushState`/`replaceState` and `popstate`, holds the parsed route in state, and
dispatches a `navigate` `CustomEvent` on every change, exposing only
`NavigationPort`. The paths, verbs, and bodies the client sends are unchanged
from before the split.

Rules:

- UI components receive data and callbacks. They do not call `fetch`,
  `EventSource`, `window.history`, or any module that does, and no component
  imports an adapter module.
- Orchestration lives in application. A component may own local presentation
  state (an open dialog, a draft string); it must not own loading, refresh, or
  auth sequencing.
- Route parsing and path building are pure domain functions. History writes and
  `popstate` listeners are the history adapter.
- One ports module: `web/src/application/ports.ts`. An adapter implements a
  port; application code depends on the interface only.

Web tree:

```
web/src/
  domain/       types.ts  presentation.ts  routes.ts
  application/  ports.ts  errors.ts  workspace.ts
  adapters/     api-client.ts  realtime.ts  history.ts
  ui/           AppView.tsx  Boot.tsx  Board.tsx  CommandPalette.tsx
                Dialog.tsx  IssueDetail.tsx  Modal.tsx  NewIssueDialog.tsx
                ProjectSetup.tsx  Queue.tsx  Shell.tsx  SignIn.tsx
                Toasts.tsx  ui.tsx  styles.css
  main.tsx      composition entrypoint: only module importing both application and ui
```

### Comparison with the reference client

`/home/dietkyle/projects/contract-iq/apps/frontend/src` is a prototype, not a
model implementation: many files start with `// @ts-nocheck`, data is mocked, and
several views call transport hooks directly. It is used here only to make the
mapping concrete. The path is machine-local and the comparison is illustrative;
the repository has no dependency on it.

| Reference directory | What it holds | Curved layer | What the example lacks |
|---|---|---|---|
| `api/` (`client.ts`, `endpoints.ts`, `hooks.ts`, `auth.ts`) | `fetch` wrapper, TanStack Query hooks, auth headers from `localStorage` | Adapters (client) plus application (orchestration behind ports) | No port boundary; hooks are called straight from views; errors collapse to a generic `Error`, so no stable code reaches the UI |
| `components/` | Presentational primitives (badge, button, card, sidebar) | UI | `@ts-nocheck`, no data/callback contract, no separation from page logic |
| `design-system/` | CSS tokens and global styles | UI styling | Tokens only; no component behavior |
| `data/` (`mock.ts`) | Fixture records exported as production code | No counterpart | No domain types; fixtures live in the app tree |
| `lib/` (`cn`, `formatCurrency`, `daysUntil`) | Pure formatting helpers | Web domain | No status contract, no route parsing, no filtering rules |
| `routes/` and `views/` | Page components; views import `api/hooks` | UI pages | Transport inside views; `currentView` navigation comes from state, not a parsed URL |
| `stores/` (zustand) | `sidebarOpen`, `currentView` | Application/UI state | Navigation state in a store instead of route parsing |
| `__tests__/` | Smoke tests | Web domain tests (no web runner yet) | Covered by neither layer definition nor a port |

## 7. Testing policy

Tests prove exterior behavior. They call the seam an end user or agent hits, not
a private function, not SQL text, not the module graph.

The existing suites are the regression contract: 195 tests in 17 files under
`test/` (189 behavior, 6 architecture), run by `npm test`
(`node --test --test-concurrency=1 test/*.test.ts`).
They need the Postgres from `docker compose` on port 55432: `bash scripts/db.sh`
bootstraps it, and `test/helpers/db.ts` refuses any database whose name does not
start with `curved_test`.

The migration may update imports and setup in those files; it may not weaken an
assertion or delete a case to make a move pass. If a rule moves, its test moves
with it and keeps asserting the same code, message, or state.

| Seam | Files | What it proves |
|---|---|---|
| Application use cases against a real Postgres test database | `test/transitions.test.ts`, `test/issues.test.ts`, `test/agents.test.ts` (claim and queue cases), `test/blocking.test.ts`, `test/comments.test.ts`, `test/labels.test.ts`, `test/relations.test.ts`, `test/events.test.ts`, `test/projects.test.ts` (use cases, plus the transaction-scoped ports commit/rollback and repository find-by-key cases); setup via `openTestDatabase` in `test/helpers/db.ts` | Transition graph and actor authority, claim fence, claim-column transitions, event appends, error codes and messages |
| HTTP routes against the built app | `test/http.test.ts` constructs `createApp` with ports and a real `createEventHub` instance (closed in teardown) and calls `app.handle` with real `Request` objects; its SPA fallback cases construct their own `createApp` with a fixture `webDistDir`. `test/github.test.ts` also belongs here: it creates a hub and drives webhook cases through `createApp`; only its three pure-helper cases and the use case guard case that bypasses HTTP do not | Status codes, auth (UI bearer, session cookie, `crv_` agent bearer), payload shapes, no-CORS and JSON rules, SPA serving and 503, webhook signature and event mapping |
| SSE and the event hub | `test/sse.test.ts`, `test/event-hub.test.ts` with a real hub against Postgres | `ready`/`issues_changed`/`ping` frames, cookie-only stream auth, one LISTEN client shared by subscribers, subscription release on cancel |
| Spawned CLI | `test/cli.test.ts` runs `node src/composition/cli.ts` as a child process | argv parsing, output, exit codes, agent token handling |
| Spawned MCP stdio process | `test/mcp.test.ts` runs `src/composition/mcp.ts` through `StdioClientTransport` | Tool schemas, agent resolution from `CURVED_AGENT_TOKEN`, results and error results |
| Raw-SQL invariant proofs | `test/events.test.ts` and `test/comments.test.ts` assert SQLSTATE `23001` on UPDATE and DELETE of `issue_events`; `test/migrate.test.ts` proves concurrent migration runs apply each file once | Database-enforced invariants that no TypeScript test can prove |
| Import direction | `test/architecture.test.ts` spawns `scripts/check-architecture.mjs` | The repository passes the nine rules and five fixture trees fail: application -> adapter, domain -> `pg`, web ui -> adapter, web application -> adapter, and web domain -> backend module (section 9). This is a gate, not behavior coverage |

Additional rules:

- No new implementation-detail tests: do not assert that a helper exists, that a
  function has a particular statement count, or that a module imports another
  module. `npm run check:arch` covers import direction (section 9); it is not a
  substitute for a behavior test. The one named exception is the existing
  query-budget assertion in `test/labels.test.ts` (three statements for a
  listing page, SQL text filtered for `issue_labels` and `issue_relations`): the
  budget is part of the contract, so it stays and must not be weakened, but it
  is not a substitute for behavior coverage.
- Do not replace the real database with a mock. The SQL invariants are the
  product.
- Every new rule (a new edge, a new fence, a new claim rule) needs a test at the
  seam an agent or human actually uses, which fails without the change.

Web testing today: there is no unit test framework for the SPA (no web test
script, no DOM test runner). Current evidence, re-run by LAS-176 from a clean
state, is `npm run check` (typecheck, architecture check, and 195 tests),
`npm run build` (`npm run typecheck` then `npm run build:web`, a `vite build`),
and a browser pass at 390x844 and desktop, which LAS-175 performed and LAS-176
repeated: both viewports, sign-out and sign-in with rejected and accepted
tokens, first-run project setup on a fresh database, board, ready queue, issue
detail transition and comment, Ctrl/Cmd+K palette, cross-tab SSE refresh, and a
server-restart reconnect, with no console errors. This is a known constraint:
web formatting, filtering, and route parsing have no automated proof today. When
a web runner is added, the pure web domain (status maps, filters, sorting,
route parsing) is the first place to test, not component snapshots.

## 8. Review checklist

For a new module or a moved one:

- [ ] Which layer is this? Does its path match the layer map in section 1
      (server) or section 6 (web)?
- [ ] Does it import only inward (domain imports nothing; application imports
      domain and ports; adapters import domain, application ports and use cases,
      and only the sanctioned peer set `http` -> `github`, `sse`, `static`)?
      This is machine-checked by `npm run check:arch`; review the cases the
      check cannot see.
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
- [ ] Does the web file sit in the layer its path names (`domain`, `application`,
      `adapters`, `ui`), with ports declared in `application/ports.ts` and
      components free of transport (`fetch`, `EventSource`, `history`, adapter
      modules)?

## 9. Enforcement

`npm run check` is the normal gate. It runs `npm run typecheck` (server and web
configs), `npm run check:arch`, and `npm test` (195 tests). `./scripts/init.sh`
runs install, database (`bash scripts/db.sh`), check, then build;
`--no-install` skips only install. `./scripts/clean-state.sh` is the
end-of-session gate.

`npm run check:arch` runs `node scripts/check-architecture.mjs`: plain Node ESM,
no dependencies. It walks `src/**/*.ts` and `web/src/**/*.ts(x)` (skipping
`node_modules`, `dist`, and `test`), extracts static imports, side-effect
imports, dynamic imports, and `require` specifiers, resolves relative paths
against the repository root, and applies nine rules:

| Rule | Applies to | Forbids |
|---|---|---|
| `domain-boundary` | `src/domain/**` | `src/application/**`, `src/adapters/**`, `src/composition/**`, `pg`, `node:*`, `react`, `react-dom` |
| `application-boundary` | `src/application/**` | `src/adapters/**`, `src/composition/**`, `pg`, `node:*`, `react`, `react-dom` |
| `adapter-boundary` | `src/adapters/**` | `src/composition/**`, and any other adapter directory outside the sanctioned set `http` -> `github`, `sse`, `static` |
| `pg-import` | all of `src/**` outside `src/adapters/postgres/**` | `pg` |
| `web-backend-import` | `web/src/**` | every backend module except exactly `src/domain/status.ts` |
| `web-domain-layer` | `web/src/domain/**` | `react`, `react-dom`, web adapters, web application, web ui |
| `web-application-layer` | `web/src/application/**` | web adapters, web ui |
| `web-ui-layer` | `web/src/ui/**` | web adapters |
| `web-adapter-layer` | `web/src/adapters/**` | web ui |

Root-level `src/adapters/*.ts` files have no adapter subdirectory, so
`adapter-boundary` permits any adapter to import them; that is the shared-utility
escape hatch in section 1. The four web layer rules apply to the landed
`web/src/{domain,application,adapters,ui}` directories.

It prints one line per violation, `path: forbidden import "specifier" (rule)`,
and exits 1; on success it prints `architecture: ok (<N> files)` and exits 0; a
bad argument exits 2. `--root <dir>` points the walker at another tree, which is
how `test/architecture.test.ts` runs it: one case proves the real repository
passes, and five fixture trees prove a violation fails for application ->
adapter, domain -> `pg`, web ui -> web adapter, web application -> web adapter,
and web domain -> backend module (`web/src/domain/bad.ts` importing
`src/application/ports.ts`).

The `pg` rule is scoped to production code under `src/**`; `test/` is outside
the walk. The test tree's pg-error assertions import `pgErrorCode` and
`pgErrorConstraint` from `src/adapters/postgres/pool.ts`, and `test/migrate.test.ts`
and the event suites keep their raw SQLSTATE assertions.

Composition roots are exempt by construction: `src/composition/**` may import any
inward layer, and that is the only place allowed to read `process.env` and
construct a pool. No dual-role file remains on either side: every backend file
sits in exactly one layer, and every file under `web/src/` sits in its layer,
with `web/src/main.tsx` as the only web composition module.

Two limits worth stating rather than hiding:

- Import direction does not detect a duplicated rule (a copied enum, a second
  regex). Those stay review items unless the check later grows a
  symbol-declaration scan.
- Browser globals (`fetch`, `EventSource`, `history`) are not imports, so the
  "UI receives data and callbacks" rule is enforced by review and by the web
  application ports until a lint rule covers them. The specifier scan is also
  text-based: a computed `import()` or `require()` target is not seen.

## 10. Verification record (LAS-176)

LAS-176 closed the refactor on 2026-11-17. It re-ran the baseline and
clean-state gates and repeated the entry-point smokes; this section records what
was proven, so a later change can tell evidence from assumption. No gate failed
and no product behavior changed.

### Static boundary proof

- `src/domain/` holds 9 files and 16 import specifiers, all sibling domain
  modules: zero bare or package specifiers.
- `src/application/` holds 11 files importing only `../domain/*.ts`,
  `./ports.ts`, and its own use-case modules. No `pg`, `node:*`, `react`,
  crypto, adapter, composition, or `process.env` reference appears there.
- All 12 old-layer paths are absent: `src/services/`, `src/db.ts`,
  `src/config.ts`, `src/migrate.ts`, `src/server.ts`, `src/cli.ts`,
  `src/http/`, `src/mcp/`, `web/src/app.tsx`, `web/src/lib/`,
  `web/src/components/`, and `web/src/styles.css`. No `export ... from`
  re-export shim exists anywhere in `src/` or `web/src/`.
- The nine rules in `scripts/check-architecture.mjs` match section 9, every
  file under the walked trees falls in a layer, and the check reports
  `architecture: ok (74 files)`.

### Behavior audit

The audit covered `899e62f..c97af0f`, where `899e62f` is the commit before
LAS-169 and `b079662` is the LAS-169 commit itself. It found no unrecorded
product behavior difference. The only deltas:

- Test wiring and imports: `testDb.db` -> `testDb.ports`, `createApp` options,
  spawn paths, and helper calls.
- Three semantically identical test expressions: `hashAgentToken` ->
  `createTokenCodec().hash`, the rollback test using the transaction handle it
  was testing, and the missing-build test de-wrapped because `App.close` is
  gone.
- The architecture suite's fixture rename `web/src/lib` -> `web/src/domain`
  and one new architecture case, taking the suite from 189 to 195 tests.
- One user-visible text change: the MCP blank-token hint now names
  `node src/composition/cli.ts agent add <name>`. The CLI hint still uses
  `curved agent add <name>`, and no test pinned either path.
- Entrypoint commands moved to `src/composition/*` in `package.json` and
  `scripts/db.sh`.
- Internal seams: `createApp` takes an injected `EventHub` and has no
  `close()`; the web history hook memoizes route and navigate.

### Runtime evidence

Each smoke ran against a throwaway `curved_test_*e2e176*` database, dropped
afterward. No repository file was edited and no listener was left behind.

- CLI on a fresh database: `project add`, `project list`, `issue add`,
  `issue list`, `issue show`, `issue move`, and `agent add --json` (which
  minted a `crv_` token) all produced the documented output.
- MCP over stdio with that real token: `tools/list` returned exactly the eight
  tools; `list_ready`, `claim_next` (claiming the issue and naming the agent),
  a second `claim_next` returning `agent_busy` with the active key, `comment`,
  `submit_for_review` (which kept the claim), `get_issue`, `claim_next` while
  in review returning `agent_busy`, `release_claim` from in review returning
  `illegal_transition`, a human move to done, `claim_next` claiming the next
  issue, `mark_blocked`, and `create_issue` all behaved as documented; a bogus
  token returned `not_authenticated: agent token is not valid`.
- HTTP and SSE in Chromium at 1440x900 and 390x844: `/` served the built SPA
  with CSS, JS, and fonts at 200; a wrong UI token was rejected inline and the
  real token set the HttpOnly `curved_session` cookie; first-run setup created
  the project with a toast; `/new` created an issue and the board showed all
  five lanes with counts; a CLI-created issue appeared in both tabs without a
  reload over one `EventSource` and one navigation entry; the queue showed
  READY 1 / IN FLIGHT 1; the issue deep link rendered its timeline and accepted
  a UI comment; Ctrl/Cmd+K searched and navigated; the phone tab showed the
  five status tabs at 44x78 px with counts and no horizontal overflow. The
  first SSE frame was `event: ready`.
- Reconnect: with the server stopped, both tabs recorded `EventSource` errors
  and `readyState=2`; after restart the adapter reconnected (a new stream,
  `readyState=1`, `ready` within about 5 ms of the port accepting connections,
  inside the 1 s retry), and a new CLI comment and issue appeared in both tabs
  without a reload. Clean loads produced 0 console entries and 0 page errors.
- Webhook through the HTTP app: a valid signed `opened` pull request moved an
  in-progress issue to in review with exactly one `git` status event; replay
  was ignored with `{"ok":true,"ignored":true}` and no second event; wrong and
  missing signatures returned 401 `not_authenticated`; an unknown key, an
  `opened` PR for a todo issue, `push`, and an unmerged closed PR were ignored
  with 200; malformed JSON with a valid signature returned 400 `validation`; a
  merged closed PR moved in review to done; `GET /webhooks/github` returned
  404; a server started without `GITHUB_WEBHOOK_SECRET` returned 503
  `webhook_not_configured` and left data untouched.
- Unknown `/api` paths returned JSON 404, not HTML.

### Intentional deviations

- Fixed warm near-black palette, no light mode, and self-hosted fonts (LAS-152)
  remain. They are recorded product decisions; the refactor did not revisit
  them.
- The MCP blank-token hint names the composition entrypoint rather than the
  `curved` binary. The old adapter paths are gone, and no test or documented
  contract pinned the string.
- HTTP, MCP, and CLI error codes and messages are otherwise unchanged;
  rendering stays `"<code>: <message>"` per section 5.
- `createApp` takes an injected `EventHub` and exposes no `close()`; the tests
  own hub lifetime. The HTTP surface and payloads are unchanged.

### Known limits

- The architecture check is path- and specifier-based: it cannot see a
  duplicated rule or literal, a computed `import()`/`require()` target, or a
  browser global used directly.
- There is no frontend test runner, so web formatting, filtering, and route
  parsing still have no automated proof.
- The browser smoke is manual and was run twice (LAS-175, LAS-176); it is not a
  CI job.
