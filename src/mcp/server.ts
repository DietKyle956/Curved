import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { createDatabase } from "../db.ts";
import type { Database } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { authenticateAgent } from "../services/agents.ts";
import {
  claimNext,
  claimNextInput,
  comment,
  commentInput,
  createIssue,
  createIssueInput,
  getIssue,
  getIssueInput,
  listReady,
  listReadyInput,
  markBlocked,
  markBlockedInput,
  releaseClaim,
  releaseClaimInput,
  runTool,
  submitForReview,
  submitForReviewInput,
} from "./tools.ts";
import type { ToolDeps } from "./tools.ts";

/**
 * Resolves the agent named by `CURVED_AGENT_TOKEN`. Every tool call goes
 * through this, so a missing or unknown token fails authentication.
 */
export async function resolveAgentFromToken(
  db: Database,
  config: Config,
): Promise<string> {
  const token = config.agentToken.trim();
  if (token.length === 0) {
    throw new ServiceError(
      "not_authenticated",
      'no agent token: set CURVED_AGENT_TOKEN to a token created with "node src/cli.ts agent add <name>"',
    );
  }
  const agent = await authenticateAgent(db, token);
  return agent.name;
}

/** Builds the MCP server with Curved's agent tools registered. */
export function createCurvedMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "curved", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "claim_next",
    {
      title: "Claim Next Issue",
      description:
        "Claim the highest-priority ready issue for the authenticated agent and return the issue with its timeline.",
      inputSchema: claimNextInput,
    },
    (input) => runTool(() => claimNext(deps, input)),
  );

  server.registerTool(
    "comment",
    {
      title: "Comment on Issue",
      description: "Append a comment event to an issue.",
      inputSchema: commentInput,
    },
    (input) => runTool(() => comment(deps, input)),
  );

  server.registerTool(
    "create_issue",
    {
      title: "Create Issue",
      description: "Create an issue in a project and return the new issue.",
      inputSchema: createIssueInput,
    },
    (input) => runTool(() => createIssue(deps, input)),
  );

  server.registerTool(
    "get_issue",
    {
      title: "Get Issue",
      description: "Read one issue by key together with its event timeline.",
      inputSchema: getIssueInput,
    },
    (input) => runTool(() => getIssue(deps, input)),
  );

  server.registerTool(
    "list_ready",
    {
      title: "List Ready Issues",
      description:
        "List ready issues, optionally for one project, plus the authenticated agent's active claim.",
      inputSchema: listReadyInput,
    },
    (input) => runTool(() => listReady(deps, input)),
  );

  server.registerTool(
    "mark_blocked",
    {
      title: "Mark Issue Blocked",
      description:
        "Block the authenticated agent's claimed issue with a reason and return it to the backlog.",
      inputSchema: markBlockedInput,
    },
    (input) => runTool(() => markBlocked(deps, input)),
  );

  server.registerTool(
    "release_claim",
    {
      title: "Release Claim",
      description:
        "Release the authenticated agent's claim and return the issue to the ready backlog.",
      inputSchema: releaseClaimInput,
    },
    (input) => runTool(() => releaseClaim(deps, input)),
  );

  server.registerTool(
    "submit_for_review",
    {
      title: "Submit for Review",
      description:
        "Submit the authenticated agent's claimed issue for review with a summary.",
      inputSchema: submitForReviewInput,
    },
    (input) => runTool(() => submitForReview(deps, input)),
  );

  return server;
}

/** Serves MCP over stdio until stdin ends or the process is signalled. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  const handle = serveStdio(
    () =>
      createCurvedMcpServer({
        db,
        resolveAgent: () => resolveAgentFromToken(db, config),
      }),
    {
      onerror: (error) => {
        process.stderr.write(`curved mcp: ${error.message}\n`);
      },
    },
  );

  let closing: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (closing === null) {
      closing = (async () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.stdin.off("end", onStdinEnd);
        await handle.close();
        await db.close();
      })();
    }
    return closing;
  };
  const onSignal = (): void => {
    void shutdown();
  };
  const onStdinEnd = (): void => {
    void shutdown();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.stdin.on("end", onStdinEnd);
}
