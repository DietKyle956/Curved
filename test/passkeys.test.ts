import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createApp } from "../src/adapters/http/app.ts";
import { createEventHub } from "../src/adapters/postgres/event-hub.ts";
import type { EventHub } from "../src/application/ports.ts";
import { validatePasskeyNickname } from "../src/domain/validation.ts";
import { openTestDatabase, type TestDatabase } from "./helpers/db.ts";

const UI_TOKEN = "test-ui-token";
const JSON_HEADERS = { "content-type": "application/json" };
const HUMAN_BEARER = { authorization: `Bearer ${UI_TOKEN}` };
const WEBAUTHN = { rpID: "localhost", origins: ["http://localhost"] };

interface HttpApp {
  handle(request: Request): Promise<Response>;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

interface AvailableResponse {
  available: boolean;
}

interface Passkey {
  id: string;
  nickname: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface PasskeysResponse {
  passkeys: Passkey[];
}

interface RegistrationOptionsResponse {
  challengeId: string;
  options: {
    rp: { id: string; name: string };
    challenge: string;
    excludeCredentials?: Array<{ id: string; transports?: string[] }>;
  };
}

interface LoginOptionsResponse {
  challengeId: string;
  options: {
    challenge: string;
    allowCredentials?: Array<{ id: string; transports?: string[] }>;
  };
}

let testDb: TestDatabase;
let hub: EventHub;
let app: HttpApp;

before(async () => {
  testDb = await openTestDatabase();
});

beforeEach(async () => {
  await testDb.reset();
  hub = createEventHub({
    databaseUrl: testDb.databaseUrl,
    logger: () => {},
  });
  app = createApp({
    ports: testDb.ports,
    events: hub,
    uiToken: UI_TOKEN,
    webauthn: WEBAUTHN,
    logger: () => {},
  });
});

afterEach(async () => {
  await hub.close();
});

after(async () => {
  await testDb.close();
});

function request(
  target: HttpApp,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return target.handle(new Request(new URL(path, "http://localhost"), init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return request(app, path, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

async function seedPasskey(): Promise<void> {
  await testDb.ports.passkeys.create({
    id: "cred-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ["internal"],
    deviceType: "singleDevice",
    backedUp: false,
    nickname: "Phone",
  });
}

async function startRegistration(): Promise<RegistrationOptionsResponse> {
  const response = await request(app, "/api/passkeys/options", {
    method: "POST",
    headers: HUMAN_BEARER,
  });
  assert.equal(response.status, 200);
  return readJson<RegistrationOptionsResponse>(response);
}

test("passkey availability tracks registered credentials without auth", async () => {
  const empty = await request(app, "/api/passkeys/available");
  assert.equal(empty.status, 200);
  assert.deepEqual(await readJson<AvailableResponse>(empty), {
    available: false,
  });

  await seedPasskey();

  const seeded = await request(app, "/api/passkeys/available");
  assert.equal(seeded.status, 200);
  assert.deepEqual(await readJson<AvailableResponse>(seeded), {
    available: true,
  });
});

test("listing passkeys with the bearer omits verification material", async () => {
  await seedPasskey();

  const response = await request(app, "/api/passkeys", {
    headers: HUMAN_BEARER,
  });
  assert.equal(response.status, 200);

  const body = await readJson<PasskeysResponse>(response);
  assert.equal(body.passkeys.length, 1);
  const passkey = body.passkeys[0];
  assert.ok(passkey !== undefined);
  assert.equal(passkey.id, "cred-1");
  assert.equal(passkey.nickname, "Phone");
  assert.equal(Object.hasOwn(passkey, "publicKey"), false);
});

test("registration options name the relying party and exclude known credentials", async () => {
  await seedPasskey();

  const body = await startRegistration();
  assert.equal(body.options.rp.id, "localhost");
  assert.equal(typeof body.options.challenge, "string");
  assert.ok(body.options.challenge.length > 0);
  assert.equal(typeof body.challengeId, "string");
  assert.ok(body.challengeId.length > 0);

  const excluded = body.options.excludeCredentials ?? [];
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0]?.id, "cred-1");

  const anonymous = await request(app, "/api/passkeys/options", {
    method: "POST",
  });
  assert.equal(anonymous.status, 401);
});

test("a failed registration consumes its challenge exactly once", async () => {
  const { challengeId } = await startRegistration();

  const first = await postJson(
    "/api/passkeys",
    { challengeId, nickname: "Phone 2", response: {} },
    HUMAN_BEARER,
  );
  assert.equal(first.status, 400);
  const firstError = await readJson<ErrorResponse>(first);
  assert.equal(firstError.error.code, "validation");

  const second = await postJson(
    "/api/passkeys",
    { challengeId, nickname: "Phone 2", response: {} },
    HUMAN_BEARER,
  );
  assert.equal(second.status, 400);
  const secondError = await readJson<ErrorResponse>(second);
  assert.equal(secondError.error.code, "validation");
  assert.match(secondError.error.message, /challenge is missing or expired/);
});

test("login options stop once every passkey is deleted", async () => {
  await seedPasskey();

  const options = await request(app, "/api/session/passkey/options", {
    method: "POST",
  });
  assert.equal(options.status, 200);
  const optionsBody = await readJson<LoginOptionsResponse>(options);
  const allowed = optionsBody.options.allowCredentials ?? [];
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0]?.id, "cred-1");

  const deleted = await request(app, "/api/passkeys/cred-1", {
    method: "DELETE",
    headers: HUMAN_BEARER,
  });
  assert.equal(deleted.status, 204);

  const afterDelete = await request(app, "/api/session/passkey/options", {
    method: "POST",
  });
  assert.equal(afterDelete.status, 400);
  const error = await readJson<ErrorResponse>(afterDelete);
  assert.equal(error.error.code, "validation");
  assert.match(error.error.message, /no passkeys are registered/);
});

test("an unknown credential fails sign-in and consumes its challenge", async () => {
  await seedPasskey();

  const options = await request(app, "/api/session/passkey/options", {
    method: "POST",
  });
  assert.equal(options.status, 200);
  const { challengeId } = await readJson<LoginOptionsResponse>(options);

  const first = await postJson("/api/session/passkey", {
    challengeId,
    response: { id: "unknown" },
  });
  assert.equal(first.status, 401);
  assert.equal((await readJson<ErrorResponse>(first)).error.code, "not_authenticated");

  const second = await postJson("/api/session/passkey", {
    challengeId,
    response: { id: "unknown" },
  });
  assert.equal(second.status, 401);
  assert.match(
    (await readJson<ErrorResponse>(second)).error.message,
    /challenge is missing or expired/,
  );
});

test("nicknames must be non-empty and at most 60 characters", () => {
  assert.throws(() => validatePasskeyNickname(""), /must not be empty/);
  assert.throws(() => validatePasskeyNickname("   "), /must not be empty/);
  assert.throws(
    () => validatePasskeyNickname("x".repeat(61)),
    /at most 60 characters/,
  );
  assert.equal(validatePasskeyNickname("x".repeat(60)), "x".repeat(60));
});
