import { Fingerprint, Key } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { relativeTime } from "../domain/presentation.ts";
import type { PasskeySummary } from "../domain/types.ts";
import { Dialog } from "./Dialog.tsx";
import { Button, EmptyState, Field, Spinner } from "./ui.tsx";

const DEFAULT_NICKNAME = "Passkey";

function describeDevice(passkey: PasskeySummary): string {
  const scope =
    passkey.deviceType === "multiDevice"
      ? "synced across devices"
      : "this device only";
  return passkey.backedUp ? `${scope} · backed up` : `${scope} · not backed up`;
}

export function PasskeysDialog({
  open,
  onClose,
  supported,
  passkeys,
  loading,
  error,
  onAdd,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  supported: boolean;
  passkeys: PasskeySummary[];
  loading: boolean;
  error: string | null;
  onAdd: (nickname: string) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
}) {
  const [nickname, setNickname] = useState(DEFAULT_NICKNAME);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setNickname(DEFAULT_NICKNAME);
    setSubmitting(false);
    setRemovingId(null);
  }, [open]);

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const label = nickname.trim();
    setSubmitting(true);
    const ok = await onAdd(label.length === 0 ? DEFAULT_NICKNAME : label);
    setSubmitting(false);
    if (ok) {
      setNickname(DEFAULT_NICKNAME);
    }
  }

  async function remove(id: string): Promise<void> {
    if (removingId !== null) {
      return;
    }
    setRemovingId(id);
    await onRemove(id);
    setRemovingId(null);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Passkeys"
      description="Sign in with your device instead of pasting a token."
      size="md"
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12px] leading-relaxed text-fg-muted">
          Sign in with Face ID, Touch ID, or a security key.
        </p>

        {supported ? (
          <form onSubmit={(event) => void add(event)}>
            <Field label="Nickname" hint="Shown here so you can tell passkeys apart.">
              {(id) => (
                <div className="flex items-center gap-2">
                  <input
                    id={id}
                    data-testid="passkey-nickname"
                    value={nickname}
                    onChange={(event) => {
                      setNickname(event.target.value);
                    }}
                    className="field-input"
                    placeholder={DEFAULT_NICKNAME}
                    autoComplete="off"
                    maxLength={60}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    data-testid="passkey-add"
                    loading={submitting}
                    icon={<Fingerprint className="size-3.5" aria-hidden="true" />}
                  >
                    Add passkey
                  </Button>
                </div>
              )}
            </Field>
          </form>
        ) : (
          <p
            data-testid="passkeys-unsupported"
            className="rounded-ui border border-line bg-elevated px-3 py-2.5 text-[11.5px] leading-snug text-fg-muted"
          >
            This browser cannot create passkeys. Open Curved in a browser with
            WebAuthn support.
          </p>
        )}

        {error !== null ? (
          <p
            data-testid="passkeys-error"
            className="rounded-ui border border-storm/30 bg-storm/10 px-3 py-2 text-[11.5px] leading-snug text-storm"
          >
            {error}
          </p>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[11.5px] text-fg-muted">
            <Spinner className="size-3.5" />
            Loading passkeys…
          </div>
        ) : passkeys.length === 0 ? (
          <EmptyState
            testId="passkeys-empty"
            icon={<Fingerprint className="size-5" />}
            title="No passkeys yet."
            body="Add one above, then sign in with just your device."
          />
        ) : (
          <ul
            aria-label="Registered passkeys"
            className="flex list-none flex-col divide-y divide-line rounded-ui border border-line bg-panel p-0"
          >
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                data-testid="passkey-row"
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-ui border border-line bg-elevated text-fg-secondary">
                  <Key className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-[12.5px] font-medium text-fg">
                      {passkey.nickname}
                    </p>
                    {passkey.usable ? null : (
                      <span className="inline-flex shrink-0 items-center rounded-ui border border-line bg-elevated px-1.5 py-0.5 font-mono text-[9.5px] leading-none tracking-[0.06em] text-fg-muted uppercase">
                        Different domain
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10.5px] leading-snug text-fg-muted">
                    Added {relativeTime(passkey.createdAt)} ·{" "}
                    {describeDevice(passkey)}
                  </p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  loading={removingId === passkey.id}
                  disabled={removingId !== null && removingId !== passkey.id}
                  onClick={() => void remove(passkey.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
