# MEMORY.md

- **Last updated:** 2026-11-10
- **Project:** curved
- **Phase:** greenfield. Agent harness installed, no application code yet.

## Current verified state

- Repository root: `/home/dietkyle/projects/curved`
- Startup path: `./scripts/init.sh` (also `--no-install` to skip install)
- End-of-session gate: `./scripts/clean-state.sh`
- Baseline: green. Install/check/build/start are `true` placeholders because no
  `package.json` exists.
- Git repository on branch `main`, remote `origin`
  (`https://github.com/DietKyle956/Curved.git`), public on GitHub.
- Index: `.codegraph/` initialized, gitignored.

## Decisions

- Stack: TypeScript + Node.js (from `initial_idea.md`). Mobile-first UI, agent-first API.
- The state machine and agent tool interface are the product; the board is a client.
- Postgres is the store: issues, relations, labels, comments, `issue_events`, plus a
  partial unique index for one `in_progress` issue per project/agent.

## Open questions

- Transport for the agent interface: MCP server, plain CLI, or both.
- Realtime for the human UI: polling vs `LISTEN`/`NOTIFY`.
- Do we take the first step as schema migrations, or the agent tool surface first.

## Next best step

Execute spec LAS-140: create the Node project skeleton (`package.json`, TS configs,
test runner), then replace the placeholder commands in `scripts/init.sh` so the
baseline checks something real. Phases: scaffold and database, service layer,
agent surfaces, HTTP and SPA.

## Tracker

- Linear workspace: last-known-good (`LAS`).
- Project: Curved (`P-LAS-8`).
- Spec issue: `LAS-140`, labelled `ready-for-agent`.
- Test seams agreed: service layer (primary), HTTP in-process fetch, raw SQL only
  for the append-only trigger and the partial unique index.
- Sub-issues (15, native `blockedBy` edges):
  - `LAS-141` foundation: toolchain, Postgres, migrations, project creation
  - `LAS-142` issue capture, atomic keys, append-only events (141)
  - `LAS-143` comments and timeline read path (142)
  - `LAS-144` status machine and actor matrix (142)
  - `LAS-145` agent identity and claim fence (144)
  - `LAS-146` block and unblock (145)
  - `LAS-147` MCP server over stdio (146)
  - `LAS-148` HTTP API and auth boundary (146)
  - `LAS-149` labels, relations, dependency-aware ready (148)
  - `LAS-150` SSE realtime stream (148)
  - `LAS-151` GitHub webhook and branch helper (148)
  - `LAS-152` SPA sign-in, setup, board (148, 149, 150)
  - `LAS-153` issue detail and human actions (152)
  - `LAS-154` command palette (153)
  - `LAS-155` end-to-end acceptance gate (147, 151, 153, 154)

## Session log

### Session 001

- Date: 2026-11-10
- Goal: install the repo agent harness.
- Completed: `AGENTS.md`, `MEMORY.md`, `scripts/init.sh`, `scripts/clean-state.sh`,
  `.gitignore` codegraph entry, codegraph index.
- Verification run: `./scripts/init.sh`, `./scripts/clean-state.sh`.
- Evidence captured: baseline green, gate green.
- Commits: none, repo is not under git.
- Known risk: baseline is trivially green until a real toolchain exists.
- Next best step: Node skeleton, then real install/check/build commands.

### Session 002

- Date: 2026-11-10
- Goal: turn the `curved-core` plan into a published spec.
- Completed: Linear project `Curved` (`P-LAS-8`) created in workspace
  last-known-good; spec issue `LAS-140` created in that project with label
  `ready-for-agent`, status Todo, priority High.
- Seams confirmed with the user: service layer primary, HTTP in-process fetch,
  raw SQL only for the append-only trigger and partial unique index.
- Verification run: `get_issue LAS-140` returns the full spec, label, and
  project id.
- Commits: none, repo is not under git.
- Known risk: the spec locks Node 26.2, MCP v2, and ports 4747/55432; the
  fallbacks are recorded in Further Notes.
- Next best step: execute `LAS-141`, starting with the Node skeleton.

### Session 003

- Date: 2026-11-10
- Goal: break `LAS-140` into publishable tickets.
- Completed: 15 sub-issues of `LAS-140` published (`LAS-141` to `LAS-155`) with
  label `ready-for-agent`, state Todo, project Curved, and native `blockedBy`
  edges; each carries What to build plus acceptance criteria.
- Sequencing decisions confirmed with the user: keep 15 slices, keep ready
  dependency-aware only from `LAS-149`, keep `LAS-155` as a separate gate.
- Verification run: `get_issue LAS-142/152/155` with `fields: ["relations"]`
  returns the expected `blocks` and `blockedBy` edges.
- Known risk: `LAS-145` ships ready before relations exist, so blocking
  relations do not exclude work until `LAS-149` lands. Agent tokens arrive in
  `LAS-145`; `LAS-144` proves agent and git actors at the service seam only.
- Next best step: execute `LAS-141` (foundation), then walk the frontier:
  `LAS-142`, then `LAS-143` and `LAS-144`, and so on.

### Session 004

- Date: 2026-11-10
- Goal: put the project under version control and publish it.
- Completed: `README.md` added; git repository initialized on `main`; initial
  commit `4b66958` ("Initial commit: project scaffold and working agreement");
  public GitHub repository created at `https://github.com/DietKyle956/Curved`
  and pushed.
- Verification run: `git ls-remote origin main` equals local HEAD; `gh repo view`
  reports visibility PUBLIC, default branch main; working tree clean and tracking
  `origin/main`.
- Known risk: none new. The baseline remains placeholder-green until `LAS-141`.
- Next best step: execute `LAS-141`.
