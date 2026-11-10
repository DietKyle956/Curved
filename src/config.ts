import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
  uiToken: string;
  webhookSecret: string;
  agentToken: string;
}

const DEFAULT_DATABASE_URL = "postgres://curved:curved@127.0.0.1:55432/curved";
const DEFAULT_TEST_DATABASE_URL =
  "postgres://curved:curved@127.0.0.1:55432/curved_test";
const DEFAULT_PORT = 4747;

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

/**
 * Reads configuration from the environment. A `.env` file in the working
 * directory is loaded when present, without overriding variables that are
 * already set in the environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }

  return {
    databaseUrl: env.DATABASE_URL || DEFAULT_DATABASE_URL,
    testDatabaseUrl: env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL,
    port: readPort(env.PORT),
    uiToken: env.CURVED_UI_TOKEN ?? "",
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    agentToken: env.CURVED_AGENT_TOKEN ?? "",
  };
}
