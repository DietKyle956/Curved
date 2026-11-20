-- WebAuthn credentials for the single human operator. The public key is the
-- COSE key returned at registration; only its owner can assert for it.
create table passkey_credentials (
  id text primary key,
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device_type text not null,
  backed_up boolean not null,
  nickname text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,

  constraint passkey_credentials_id_length check (char_length(id) between 1 and 1024),
  constraint passkey_credentials_counter_nonnegative check (counter >= 0),
  constraint passkey_credentials_device_type_valid
    check (device_type in ('singleDevice', 'multiDevice')),
  constraint passkey_credentials_nickname_trimmed check (nickname = btrim(nickname)),
  constraint passkey_credentials_nickname_length
    check (char_length(nickname) between 1 and 60)
);

-- Opaque browser sessions. The cookie holds the plaintext nonce; only the
-- SHA-256 hash is stored. Token logins create a row too, so logout revokes.
create table auth_sessions (
  token_hash text primary key,
  method text not null,
  credential_id text references passkey_credentials(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,

  constraint auth_sessions_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint auth_sessions_method_valid check (method in ('token', 'passkey')),
  constraint auth_sessions_expiry check (expires_at > created_at)
);
create index auth_sessions_expires_at_idx on auth_sessions (expires_at);

-- One-shot WebAuthn challenges. `consume` deletes and returns the challenge,
-- so a challenge can never verify two responses.
create table webauthn_challenges (
  id text primary key,
  challenge text not null,
  kind text not null,
  expires_at timestamptz not null,

  constraint webauthn_challenges_id_length check (char_length(id) between 1 and 128),
  constraint webauthn_challenges_challenge_length
    check (char_length(challenge) between 1 and 1024),
  constraint webauthn_challenges_kind_valid
    check (kind in ('registration', 'authentication'))
);
create index webauthn_challenges_expires_at_idx on webauthn_challenges (expires_at);
