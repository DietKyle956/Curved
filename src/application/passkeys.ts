import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { ServiceError } from "../domain/errors.ts";
import type { PasskeySummary } from "../domain/types.ts";
import { validatePasskeyNickname } from "../domain/validation.ts";
import type { PasskeyRecord, TransactionPorts } from "./ports.ts";
import { createSession } from "./sessions.ts";
import type { CreatedSession } from "./sessions.ts";

export type { AuthenticationResponseJSON, RegistrationResponseJSON };

export interface WebAuthnConfig {
  rpID: string;
  origins: string[];
}

export const PASSKEY_RP_NAME = "Curved";
export const PASSKEY_USER_NAME = "curved";
export const PASSKEY_USER_DISPLAY_NAME = "Curved human";
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSKEY_USER_ID = new TextEncoder().encode("curved-human");

/** Strips the verification material; only what a client may see leaks out. */
export function toPasskeySummary(record: PasskeyRecord, rpID: string): PasskeySummary {
  return {
    id: record.id,
    nickname: record.nickname,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
    rpId: record.rpId,
    usable: record.rpId === rpID,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt === null ? null : record.lastUsedAt.toISOString(),
  };
}

/**
 * Reports whether this domain has a usable passkey, plus how many stored
 * credentials belong elsewhere (or predate RP ID tracking) so the UI can
 * explain why sign-in needs a fresh registration.
 */
export async function passkeysAvailable(
  ports: TransactionPorts,
  rpID: string,
): Promise<{ available: boolean; otherDomain: number }> {
  const usable = await ports.passkeys.countForRpId(rpID);
  const total = await ports.passkeys.count();
  return { available: usable > 0, otherDomain: total - usable };
}

export async function listPasskeys(
  ports: TransactionPorts,
  rpID: string,
): Promise<PasskeySummary[]> {
  const records = await ports.passkeys.list();
  return records.map((record) => toPasskeySummary(record, rpID));
}

async function verifyRegistration(
  response: RegistrationResponseJSON,
  challenge: string,
  config: WebAuthnConfig,
): Promise<VerifiedRegistrationResponse> {
  try {
    return await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new ServiceError("validation", "passkey registration could not be verified");
  }
}

async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  credential: PasskeyRecord,
  challenge: string,
  config: WebAuthnConfig,
): Promise<VerifiedAuthenticationResponse> {
  try {
    return await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
      },
      requireUserVerification: true,
    });
  } catch {
    throw new ServiceError("not_authenticated", "passkey sign-in failed");
  }
}

export async function startPasskeyRegistration(
  ports: TransactionPorts,
  config: WebAuthnConfig,
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const now = new Date();
  await ports.challenges.deleteExpired(now);
  const passkeys = await ports.passkeys.list();
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: config.rpID,
    userName: PASSKEY_USER_NAME,
    userDisplayName: PASSKEY_USER_DISPLAY_NAME,
    userID: PASSKEY_USER_ID,
    attestationType: "none",
    excludeCredentials: passkeys
      .filter((record) => record.rpId === config.rpID)
      .map(({ id, transports }) => ({ id, transports })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = ports.tokens.mintNonce();
  await ports.challenges.create({
    id: challengeId,
    challenge: options.challenge,
    kind: "registration",
    expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
  });
  return { challengeId, options };
}

export async function finishPasskeyRegistration(
  ports: TransactionPorts,
  config: WebAuthnConfig,
  input: { challengeId: string; nickname: string; response: RegistrationResponseJSON },
): Promise<PasskeySummary> {
  const now = new Date();
  const challenge = await ports.challenges.consume({
    id: input.challengeId,
    kind: "registration",
    now,
  });
  if (challenge === null) {
    throw new ServiceError(
      "validation",
      "passkey registration challenge is missing or expired",
    );
  }
  const nickname = validatePasskeyNickname(input.nickname);
  const verification = await verifyRegistration(input.response, challenge, config);
  if (!verification.verified) {
    throw new ServiceError("validation", "passkey registration could not be verified");
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const record = await ports.passkeys.create({
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    nickname,
    rpId: config.rpID,
  });
  return toPasskeySummary(record, config.rpID);
}

export async function startPasskeyLogin(
  ports: TransactionPorts,
  config: WebAuthnConfig,
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const now = new Date();
  await ports.challenges.deleteExpired(now);
  const passkeys = await ports.passkeys.listForRpId(config.rpID);
  if (passkeys.length === 0) {
    throw new ServiceError(
      "validation",
      "no passkey is registered for this domain",
    );
  }
  const options: PublicKeyCredentialRequestOptionsJSON = {
    ...(await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: passkeys.map(({ id, transports }) => ({ id, transports })),
      userVerification: "required",
    })),
    hints: ["client-device"],
  };
  const challengeId = ports.tokens.mintNonce();
  await ports.challenges.create({
    id: challengeId,
    challenge: options.challenge,
    kind: "authentication",
    expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
  });
  return { challengeId, options };
}

export async function finishPasskeyLogin(
  ports: TransactionPorts,
  config: WebAuthnConfig,
  input: { challengeId: string; response: AuthenticationResponseJSON },
): Promise<CreatedSession> {
  const now = new Date();
  const challenge = await ports.challenges.consume({
    id: input.challengeId,
    kind: "authentication",
    now,
  });
  if (challenge === null) {
    throw new ServiceError(
      "not_authenticated",
      "passkey sign-in challenge is missing or expired",
    );
  }
  const id: unknown = input.response?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new ServiceError("not_authenticated", "passkey sign-in failed");
  }
  const record = await ports.passkeys.findById(id);
  if (record === null || record.rpId !== config.rpID) {
    throw new ServiceError("not_authenticated", "passkey sign-in failed");
  }
  const verification = await verifyAuthentication(input.response, record, challenge, config);
  if (!verification.verified) {
    throw new ServiceError("not_authenticated", "passkey sign-in failed");
  }
  await ports.passkeys.updateCounter({
    id: record.id,
    counter: verification.authenticationInfo.newCounter,
  });
  return createSession(ports, { method: "passkey", credentialId: record.id });
}

export async function deletePasskey(ports: TransactionPorts, id: string): Promise<void> {
  const deleted = await ports.passkeys.delete(id);
  if (!deleted) {
    throw new ServiceError("not_found", "passkey not found");
  }
}
