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
  otherDomain: number;
}

interface Passkey {
  id: string;
  nickname: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  rpId: string | null;
  usable: boolean;
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

interface SeedPasskeyOptions {
  id?: string;
  nickname?: string;
  rpId?: string;
}

async function seedPasskey(options: SeedPasskeyOptions = {}): Promise<void> {
  await testDb.ports.passkeys.create({
    id: options.id ?? "cred-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ["internal"],
    deviceType: "singleDevice",
    backedUp: false,
    nickname: options.nickname ?? "Phone",
    rpId: options.rpId ?? "localhost",
  });
}

/**
 * Seeds a credential that predates RP-scoped storage: either a row from a
 * domain that is no longer the relying party (`null` is a legacy row).
 */
async function seedOtherDomainPasskey(
  rpId: string | null = "old-domain.example",
): Promise<void> {
  await testDb.ports.passkeys.create({
    id: "cred-old",
    publicKey: new Uint8Array([4, 5, 6]),
    counter: 0,
    transports: ["internal"],
    deviceType: "singleDevice",
    backedUp: false,
    nickname: "Old laptop",
    rpId: rpId as string,
  });
}

function storedPasskeys() {
  return testDb.ports.passkeys.list();
}

async function startRegistration(): Promise<RegistrationOptionsResponse> {
  const response = await request(app, "/api/passkeys/options", {
    method: "POST",
    headers: HUMAN_BEARER,
  });
  assert.equal(response.status, 200);
  return readJson<RegistrationOptionsResponse>(response);
}

test("availability ignores credentials with no registered domain", async () => {
  const empty = await request(app, "/api/passkeys/available");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson<AvailableResponse>(empty), {
    available: false,
    otherDomain: 0,
  });

  await seedOtherDomainPasskey(null);

  const legacy = await request(app, "/api/passkeys/available");
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson<AvailableResponse>(legacy), {
    available: false,
    otherDomain: 1,
  });
});

test("availability counts only credentials for the current domain", async () => {
  await seedPasskey();

  const current = await request(app, "/api/passkeys/available");
  assert.equal(current.status, 200);
  assert.deepEqual(await readJson<AvailableResponse>(current), {
    available: true,
    otherDomain: 0,
  });

  await seedOtherDomainPasskey();

  const mixed = await request(app, "/api/passkeys/available");
  assert.equal(mixed.status, 200);
  assert.deepEqual(await readJson<AvailableResponse>(mixed), {
    available: true,
    otherDomain: 1,
  });

  const stored = await storedPasskeys();
  const byId = new Map(
    stored.map(({ id, rpId }) => [id, rpId] as const),
  );
  assert.equal(byId.get("cred-1"), "localhost");
  assert.equal(byId.get("cred-old"), "old-domain.example");
});

test("listing passkeys with the bearer omits verification material", async () => {
  await seedPasskey();
  await seedOtherDomainPasskey();

  const response = await request(app, "/api/passkeys", {
    headers: HUMAN_BEARER,
  });
  assert.equal(response.status, 200);

  const body = await readJson<PasskeysResponse>(response);
  assert.equal(body.passkeys.length, 2);

  const current = body.passkeys.find(({ id }) => id === "cred-1");
  assert.ok(current !== undefined);
  assert.equal(current.nickname, "Phone");
  assert.equal(current.rpId, "localhost");
  assert.equal(current.usable, true);
  assert.equal(Object.hasOwn(current, "publicKey"), false);

  const legacy = body.passkeys.find(({ id }) => id === "cred-old");
  assert.ok(legacy !== undefined);
  assert.equal(legacy.nickname, "Old laptop");
  assert.equal(legacy.rpId, "old-domain.example");
  assert.equal(legacy.usable, false);
  assert.equal(Object.hasOwn(legacy, "publicKey"), false);
});

test("registration options name the relying party and exclude known credentials", async () => {
  await seedPasskey();
  await seedOtherDomainPasskey();

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

test("login options offer only credentials registered for this domain", async () => {
  await seedPasskey();
  await seedOtherDomainPasskey();

  const options = await request(app, "/api/session/passkey/options", {
    method: "POST",
  });
  assert.equal(options.status, 200);
  const optionsBody = await readJson<LoginOptionsResponse>(options);
  const allowed = optionsBody.options.allowCredentials ?? [];
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0]?.id, "cred-1");
  assert.equal(
    allowed.some(({ id }) => id === "cred-old"),
    false,
  );
});

test("login options fail when only other-domain credentials exist", async () => {
  await seedOtherDomainPasskey();

  const response = await request(app, "/api/session/passkey/options", {
    method: "POST",
  });
  assert.equal(response.status, 400);
  const error = await readJson<ErrorResponse>(response);
  assert.equal(error.error.code, "validation");
  assert.match(error.error.message, /no passkey is registered for this domain/);
});

test("login options stop once every current-domain passkey is deleted", async () => {
  await seedPasskey();
  await seedOtherDomainPasskey();

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
  assert.match(error.error.message, /no passkey is registered for this domain/);
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

test("sign-in rejects an other-domain credential and consumes its challenge", async () => {
  await seedPasskey();
  await seedOtherDomainPasskey();

  const options = await request(app, "/api/session/passkey/options", {
    method: "POST",
  });
  assert.equal(options.status, 200);
  const { challengeId } = await readJson<LoginOptionsResponse>(options);

  const first = await postJson("/api/session/passkey", {
    challengeId,
    response: { id: "cred-old" },
  });
  assert.equal(first.status, 401);
  assert.equal(first.headers.get("set-cookie"), null);
  assert.equal(
    (await readJson<ErrorResponse>(first)).error.code,
    "not_authenticated",
  );

  const second = await postJson("/api/session/passkey", {
    challengeId,
    response: { id: "cred-old" },
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
