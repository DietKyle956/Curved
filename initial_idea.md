What would I need to do to build my own version of linear for use with AI agents? I really like Linear’s workflow. I just don’t want to pay for it and I want something that would be a little bit more lightweight.

Less than you’d think, because the valuable part of Linear for agents is the state machine and the API, not the UI. You already have Postgres as your backlog source and a Kanban view, so you’re partway there. The pieces:

Schema: issues (per-project sequential ID like TAC-014, title, description, status, priority, parent_id), relations (blocks/blocked-by), labels, comments, and an append-only issue_events table for status history.
Enforced state machine: Backlog → Todo → In Progress → In Review → Done, with legal transitions checked in the service layer, not the prompt. A partial unique index (one in_progress row per project or agent) fences the agent to one item at a time. An agent can’t pull a new item until the last one passes review.
Agent interface: a small MCP server or CLI with a few tools: list_ready (unblocked Todo items), claim_next, comment, submit_for_review, mark_blocked. Agents never touch SQL or the raw tables. This is the biggest difference from Linear, whose API wasn’t designed around “one agent, one item.”
Human UI: a board plus a command palette (Cmd+K) for the keyboard-driven feel. Add realtime updates, with polling or Postgres LISTEN/NOTIFY as a lighter alternative to Supabase Realtime.
Git hooks: branch name from the issue ID, plus a webhook that moves an issue to In Review on PR open and Done on merge. That’s what makes Linear feel automatic.

The idea would be to build something very lightweight. Could just use typescript / node.js. It would need to be mobile first as that is how I would interact with the app to help manage work. It's primary purpose would be for agents to interact with. 