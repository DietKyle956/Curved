# Clients

## Web client

`npm run build` produces `web/dist`, and `npm start` serves it on the same origin
as the API. Open `http://127.0.0.1:4747` and sign in with a passkey, or use the
UI-token form under the "Use a UI token" divider to sign in and add the first
passkey (Face ID, Touch ID, or a security key). The session cookie holds an
opaque server-side session and keeps it for 30 days. The first run starts with
project setup.

The client covers the core human loop:

- Board and mobile status list, with drag-to-move on desktop. Drop targets come
  from each issue's `allowedTransitions`, so the UI cannot invent an edge.
- Ready queue with claim order, in-flight agents, and human unblock.
- Issue detail with the append-only timeline, comment composer, status moves,
  field edits, label replacement, and blocking relations.
- Command palette (`Ctrl+K` or `Cmd+K`) for issue search and actions.
- Passkey management from the topbar, the sidebar footer, or the palette action
  "Manage passkeys": add a nicknamed passkey or remove one.
- Loading, empty, error, and reduced-motion states throughout.

The board and an open issue detail refresh from one `EventSource` on
`/api/events`. `issues_changed` frames are filtered by the current project id,
and the client reconnects one second after an error or close with a single-timer
guard. Window focus refresh and the manual refresh control remain; there is no
polling interval.

The palette and all screens are client-side routes under `/p/<project>`; the
server falls back to `index.html` for reloads. The theme is the fixed warm
near-black palette; there is no light mode by design.

For development, run `npm start` on 4747 and `npm run dev` on 5173. Vite proxies
`/api` to the API server, so the session cookie and JSON calls work unchanged.

## MCP server (stdio)

The MCP server speaks JSON-RPC over stdio and calls the same service layer as the
CLI. It never runs SQL itself.

Prerequisites:

1. Postgres: `docker compose up -d`.
2. Schema: `npm run migrate`.
3. An agent identity: `node src/composition/cli.ts agent add <name>` prints a
   `crv_` token once. Export it as `CURVED_AGENT_TOKEN`; only its hash is stored,
   so save it.

Start the server with `npm run mcp`, which is `node src/composition/mcp.ts`.
stdout belongs to the JSON-RPC protocol; logs go to stderr. Writing anything else
to stdout corrupts the stream.

Harness config example:

```json
{
  "mcpServers": {
    "curved": {
      "command": "node",
      "args": ["/absolute/path/to/curved/src/composition/mcp.ts"],
      "env": {
        "DATABASE_URL": "postgres://curved:curved@localhost:55432/curved",
        "CURVED_AGENT_TOKEN": "crv_..."
      }
    }
  }
}
```

Every call resolves the agent from `CURVED_AGENT_TOKEN` and acts as actor
`agent` under that agent's name.

Against the deployed host, point `DATABASE_URL` at the tunnel and use a token
minted on the server (see
[Provisioning the Oracle host](operations.md#provisioning-the-oracle-host)).
Start `deploy/agent-tunnel.sh` first, so `127.0.0.1:55433` answers:

```json
{
  "mcpServers": {
    "curved": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/curved",
      "env": {
        "DATABASE_URL": "postgres://curved:<password>@127.0.0.1:55433/curved",
        "CURVED_AGENT_TOKEN": "crv_..."
      }
    }
  }
}
```

`npm run mcp` and `node src/composition/mcp.ts` are the same entry point, so
either command works. `deploy/agent-preflight.sh` proves the checkout matches
`/srv/curved/release-state` before the tools run, and
`deploy/provisioning.md` section 19 has the full sequence.

Tools:

| Tool | Input | Result |
|---|---|---|
| `claim_next` | `{ project? }` | Claims the next ready issue, then returns `{ issue, events, children }`. |
| `comment` | `{ key, body }` | Appends a comment event and returns it. |
| `create_issue` | `{ project, title, description?, priority?, parent? }` | Returns the created issue. |
| `get_issue` | `{ key }` | Returns `{ issue, events, children }`. |
| `list_ready` | `{ project? }` | Returns `{ ready, busy }`. |
| `mark_blocked` | `{ key, reason }` | Returns the issue to Todo, clears the claim, and returns it. |
| `release_claim` | `{ key }` | Returns the issue to Todo, clears the claim, and returns it. |
| `submit_for_review` | `{ key, summary }` | Submits the issue for review and returns it. |

Successful results are the payload as pretty-printed JSON in a single text
content block. A service error becomes a text block of `<code>: <message>` with
`isError: true`, for example `not_authenticated: ...` or `agent_busy: ...`.
Invalid tool input fails zod validation before the handler runs and comes back as
an error result: `Input validation error: Invalid arguments for tool <name>: ...`.

## Agent skills

`skills/` holds three public, installer-facing agent skills for agents that use
Curved:

| Skill | Use it when |
|---|---|
| `curved-agent` | Work a Curved issue through MCP: ready queue, claim, comment, review, block, release. |
| `curved-cli` | Run Curved commands from a shell: projects, issues, agent setup, queue commands, `git-branch`, `--json`. |
| `curved-api` | Call the HTTP API and SSE stream directly with a `crv_` bearer token. |

Install them with the [skills](https://skills.sh) CLI:

```sh
npx skills add DietKyle956/Curved --list
npx skills add DietKyle956/Curved --all
```

Or copy `skills/<name>` into your agent's skill directory, for example
`~/.omp/agent/skills/` or `.claude/skills/`. The skills are generic: they read
`DATABASE_URL` and `CURVED_AGENT_TOKEN` for the CLI and MCP, or
`CURVED_BASE_URL` and `CURVED_AGENT_TOKEN` for HTTP. They contain no hostnames,
tokens, or local paths.
