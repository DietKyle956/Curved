-- WebAuthn binds a credential to exactly one RP ID, so a passkey registered at
-- one domain can never assert at another. Store the RP ID that registered each
-- credential; legacy rows predating this column keep NULL and are never offered
-- during sign-in or counted as available, because they would trigger a
-- cross-device QR flow instead of the local authenticator prompt.
alter table passkey_credentials
  add column rp_id text;

alter table passkey_credentials
  add constraint passkey_credentials_rp_id_format check (
    rp_id is null or (rp_id = lower(rp_id) and char_length(rp_id) between 1 and 253)
  );
