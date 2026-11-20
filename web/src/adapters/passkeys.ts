// WebAuthn adapter over @simplewebauthn/browser. The server sends ceremony
// options as JSON; the workspace hands them back here and passes the returned
// response JSON to the API unchanged.

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { PasskeyPort } from "../application/ports.ts";

export function createPasskeysAdapter(): PasskeyPort {
  return {
    supported: browserSupportsWebAuthn(),

    register(options: unknown): Promise<unknown> {
      return startRegistration({
        optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
      });
    },

    authenticate(options: unknown): Promise<unknown> {
      return startAuthentication({
        optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
      });
    },
  };
}
