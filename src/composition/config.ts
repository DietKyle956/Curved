import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WebAuthnConfig } from "../application/passkeys.ts";

export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
  uiToken: string;
  webhookSecret: string;
  agentToken: string;
  cookieSecure: boolean;
  webauthn: WebAuthnConfig;
}

const DEFAULT_DATABASE_URL = "postgres://curved:curved@127.0.0.1:55432/curved";
const DEFAULT_TEST_DATABASE_URL =
  "postgres://curved:curved@127.0.0.1:55432/curved_test";
const DEFAULT_PORT = 4747;

const DEFAULT_WEBAUTHN_ORIGINS = [
  "http://localhost:4747",
  "http://localhost:5173",
] as const;

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

function readCookieSecure(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") {
    return false;
  }
  const normalized = raw.toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  throw new Error(
    `COOKIE_SECURE must be "1", "true", "0", or "false", got "${raw}"`,
  );
}

function readWebAuthnOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CURVED_WEBAUTHN_ORIGINS ?? "";
  if (raw.trim() !== "") {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  const domain = (env.CURVED_DOMAIN ?? "").trim();
  if (domain !== "") {
    return [`https://${domain}`];
  }
  return [...DEFAULT_WEBAUTHN_ORIGINS];
}

function parseWebAuthnOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `CURVED_WEBAUTHN_ORIGINS entry "${raw}" is not a valid URL`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `CURVED_WEBAUTHN_ORIGINS entry "${raw}" must use http or https`,
    );
  }
  const withoutTrailingSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (url.origin !== withoutTrailingSlash) {
    throw new Error(
      `CURVED_WEBAUTHN_ORIGINS entry "${raw}" must be an origin such as "https://example.com", without a path or query`,
    );
  }
  return url;
}

function readWebAuthn(env: NodeJS.ProcessEnv): WebAuthnConfig {
  const origins = readWebAuthnOrigins(env);
  if (origins.length === 0) {
    throw new Error(
      "CURVED_WEBAUTHN_ORIGINS must list at least one http or https origin",
    );
  }
  const urls = origins.map(parseWebAuthnOrigin);
  const configuredRpId = (env.CURVED_WEBAUTHN_RP_ID ?? "").trim();
  const [firstOrigin] = urls;
  if (firstOrigin === undefined) {
    throw new Error(
      "CURVED_WEBAUTHN_ORIGINS must list at least one http or https origin",
    );
  }
  const rpID = configuredRpId !== "" ? configuredRpId : firstOrigin.hostname;
  const normalizedRpId = rpID.toLowerCase();
  for (const url of urls) {
    const host = url.hostname.toLowerCase();
    if (host !== normalizedRpId && !host.endsWith(`.${normalizedRpId}`)) {
      throw new Error(
        `CURVED_WEBAUTHN_RP_ID "${rpID}" does not cover origin "${url.origin}"; the host must equal the RP ID or be a subdomain of it`,
      );
    }
  }
  return { rpID: normalizedRpId, origins };
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
    cookieSecure: readCookieSecure(env.COOKIE_SECURE),
    webauthn: readWebAuthn(env),
  };
}
