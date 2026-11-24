# Development

## Local commands

- `npm run db` - start Postgres and apply migrations.
- `npm run dev` - run the Vite dev server on port 5173 and proxy `/api` to
  `http://127.0.0.1:4747`; start `npm start` in another terminal.
- `npm run build` - typecheck, then build the SPA into `web/dist`.
- `npm start` - run the HTTP server and SPA on `PORT` (default 4747); requires
  `CURVED_UI_TOKEN`. Run `npm run build` first for the SPA.
- `./scripts/init.sh` - install, database, check, build.
- `./scripts/clean-state.sh` - end-of-session gate.
- `npm run smoke:container` - container contract gate: local Postgres, image
  build, and runtime assertions.
  See [Container image](operations.md#container-image).
- `npm run smoke:provision` - local provisioning gate: runs the host bootstrap
  and verifier against Ubuntu 24.04 stubs in a disposable container.
  See [Provisioning the Oracle host](operations.md#provisioning-the-oracle-host).
- `npm run smoke:release` - release gate: drives `deploy/release.sh` and its
  rollback against stub binaries, with no Docker, database, or network.
  See [Releasing](operations.md#releasing).
- `npm run smoke:webhook` - webhook gate: exercises `deploy/webhook.sh` against
  a stub `gh`, covering the create and update paths without a GitHub account or
  network. See [GitHub webhook](api.md#github-webhook).
- `npm run smoke:webhook:live` - live webhook drill: opens a real pull request
  on a throwaway base branch in a real repository, waits for the GitHub
  delivery to move the issue through the deployed app and Postgres, asserts the
  timeline and status, merges, then closes the pull request, deletes the
  branches and worktree, and archives the drill project. Needs `gh` auth, the
  Curved tunnel, and network; not run by CI.
  See [GitHub webhook](api.md#github-webhook).
- `npm run smoke:backup` - backup gate: drives `deploy/backup.sh` and
  `deploy/restore.sh` against stub binaries, with no Docker, database, or
  network. See [Backups and restore](operations.md#backups-and-restore).
- `npm test` - tests run against the isolated `curved_test` database.
- `npm run check` - typecheck, the import-direction architecture check, then the
  tests.

## Acceptance gate

`npm run acceptance` is the end-to-end gate for the shipped entry points. It runs
`bash scripts/acceptance.sh`, which starts Postgres with
`bash scripts/db.sh --no-migrate` (readiness only, so the local `curved` database
gets no migrations), rebuilds `web/dist` with `npm run build:web` so the browser
leg exercises the tree under test, then hands off to
`node scripts/acceptance.mjs`.

The orchestrator creates one throwaway database,
`curved_acceptance_<pid>_<epoch>`, from `DATABASE_URL` (falling back to the repo
`.env`, then `postgres://curved:curved@127.0.0.1:55432/curved`), migrates it, and
runs every leg against it:

- `cli` - `project add`, `project list`, `project show`, `project edit` with a
  status, priority, and date change, `project archive`, and `project restore`,
  then `agent add`, `issue add`, `ready` with its busy
  line, `claim`, a second claim returning `agent_busy`, `review`, a human
  `issue move` to done, and the `no_ready_issue` exit code.
- `mcp` - the eight tools over NDJSON stdio, checked against the expected
  `tools/list` names.
- `server` - `npm start` on a free port until it prints its listening line, with
  fresh `CURVED_UI_TOKEN` and `GITHUB_WEBHOOK_SECRET` values.
- `http+sse` - the UI bearer and the session cookie, the `ready` frame, an
  `issues_changed` frame for the acceptance project, and the project assertions:
  list with `includeArchived`, detail, `PATCH` with progress, create, and
  archive, plus the built SPA.
- `webhook` - a signed `pull_request` delivery moves an issue to `in_review`, and
  the replay answers `ignored` without adding a second event.
- `browser` - `scripts/acceptance-browser.mjs` drives Chromium at 390x844 through
  sign-in, the five status tabs, palette-driven issue creation, a comment, and a
  second tab that updates in under 1100ms. It registers a passkey through
  Chromium's CDP virtual authenticator and signs in with it, printing `PASS
  browser: passkey registered ...` and `PASS browser: passkey sign-in reached the
  board ...`; the driver enables focus emulation because headless tabs otherwise
  reject WebAuthn with `NotAllowedError`. It also checks the projects page fits
  390px with no horizontal overflow, creates project `WEB` (printing `PASS
  browser: project created WEB at /p/WEB/overview with "0%" progress ...`), and
  edits its status to In progress through the dialog; the status chip renders
  uppercase and the assertion is case-insensitive.

Prerequisites: Docker with Postgres from `docker compose up -d`, and Chromium
found on `PATH` as `chromium`, `chromium-browser`, `google-chrome`, or
`google-chrome-stable`, or named by `CHROMIUM_BIN`.

Two flags reach `node scripts/acceptance.mjs` through
`npm run acceptance -- <flag>`:

- `--skip-browser` - skip the browser leg, for a machine without Chromium.
- `--keep` - keep the throwaway database and print its name instead of dropping
  it.

The browser leg writes run-scoped screenshots to the system temp directory
(`curved-acceptance-<run id>-board.png`, `-detail.png`, `-second-tab.png`) and
prints each path on its `PASS browser:` line.

Exit codes: `0` when every check passes, `1` on a failed check, a failed leg, or a
cleanup failure, and `2` on an unknown argument. Cleanup stops the children, drops
the throwaway database unless `--keep`, then re-digests the default database and
fails when any row of `projects`, `issues`, `issue_events`, `agents`, `labels`,
`issue_labels`, `issue_relations`, or `schema_migrations` changed. `SIGINT` or
`SIGTERM` cleans up the same way and exits `1`. Each `PASS <leg>:` and
`FAIL <leg>:` line names the leg that produced it.

The gate builds on the other two entry points rather than replacing them:
`./scripts/init.sh` is still the baseline (install, database, check, build) and
`./scripts/clean-state.sh` is still the end-of-session gate. This is the only one
that runs the CLI, MCP server, HTTP server, webhook, and SPA together.

Current gate counts and session evidence are recorded in `MEMORY.md`.

Public product acceptance is an operator run against the deployed stack rather
than a repository test: `deploy/provisioning.md` section 20 covers the empty
UI-token refusal, first-run project setup on a throwaway database, and a
390x844 Chromium pass over the public HTTPS surface (sign-in and session
persistence, board, queue, detail, timeline, comments, labels, relations,
palette, human unblock, and human plus agent SSE).
