import { Eye, EyeSlash } from "@phosphor-icons/react";
import { useState } from "react";
import type { FormEvent } from "react";

import { isApplicationError } from "../application/errors.ts";
import { Button, Field, LogoMark } from "./ui.tsx";

export function SignIn({
  onSignIn,
}: {
  onSignIn: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (token.trim().length === 0) {
      setError("Enter the UI token configured on the server.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSignIn(token.trim());
    } catch (caught) {
      setError(
        isApplicationError(caught)
          ? caught.message
          : "Sign in failed. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative grid min-h-[100dvh] pt-[env(safe-area-inset-top)] lg:grid-cols-[1.15fr_0.85fr]">
      <section className="relative flex min-h-[52dvh] flex-col overflow-hidden border-b border-line px-6 py-7 sm:px-10 lg:border-r lg:border-b-0 lg:px-14 lg:py-9">
        <div className="flex items-center gap-2.5">
          <LogoMark className="size-6 text-spice" />
          <span className="text-[15px] font-semibold tracking-[-0.02em] text-fg">
            Curved
          </span>
        </div>

        <div className="relative z-10 flex flex-1 items-center py-14 lg:py-8">
          <div className="w-full max-w-[38rem]">
            <h1 className="max-w-[13ch] text-[clamp(2.4rem,6vw,4.75rem)] leading-[0.94] font-semibold tracking-[-0.045em] text-balance text-fg">
              The issue tracker agents can drive.
            </h1>
            <p className="mt-5 max-w-[44ch] text-[14px] leading-relaxed text-fg-secondary">
              Status rules, claim fences, and an append-only timeline. Enforced
              in the service and Postgres, not in a prompt.
            </p>

            <dl className="mt-10 hidden max-w-xl border-y border-line lg:block">
              <div className="flex gap-5 border-b border-line py-3.5 last:border-b-0">
                <dt className="w-32 shrink-0 pt-px font-mono text-[10px] tracking-[0.06em] text-fg-muted uppercase">
                  Claim fence
                </dt>
                <dd className="text-[12.5px] leading-relaxed text-fg-secondary">
                  One active issue per agent, enforced by a partial unique index.
                </dd>
              </div>
              <div className="flex gap-5 border-b border-line py-3.5 last:border-b-0">
                <dt className="w-32 shrink-0 pt-px font-mono text-[10px] tracking-[0.06em] text-fg-muted uppercase">
                  Status machine
                </dt>
                <dd className="text-[12.5px] leading-relaxed text-fg-secondary">
                  Illegal moves are rejected by one service layer.
                </dd>
              </div>
              <div className="flex gap-5 py-3.5">
                <dt className="w-32 shrink-0 pt-px font-mono text-[10px] tracking-[0.06em] text-fg-muted uppercase">
                  Event log
                </dt>
                <dd className="text-[12.5px] leading-relaxed text-fg-secondary">
                  Status history is append-only. Rows cannot be updated or deleted.
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <svg
          viewBox="0 0 400 400"
          fill="none"
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 bottom-[-9rem] size-[26rem] text-line-strong opacity-25 sm:size-[32rem] lg:bottom-[-12rem]"
        >
          <path
            d="M355 45a220 220 0 1 0 0 310"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M320 80a170 170 0 1 0 0 240"
            stroke="currentColor"
            strokeWidth="1"
          />
          <path
            d="M285 115a120 120 0 1 0 0 170"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      </section>

      <section className="flex items-center justify-center px-6 py-12 sm:px-10 lg:px-12">
        <div className="w-full max-w-[21rem]">
          <div className="mb-7">
            <p className="font-mono text-[10px] tracking-[0.12em] text-fg-muted uppercase">
              Human access
            </p>
            <h2 className="mt-3 text-[22px] font-semibold tracking-[-0.025em] text-fg">
              Sign in
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg-secondary">
              Use the UI token configured on the server. It becomes an HttpOnly
              session cookie for this browser.
            </p>
          </div>

          <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
            <Field
              label="UI token"
              hint="Set CURVED_UI_TOKEN before starting the server."
            >
              {(id) => (
                <div className="relative">
                  <input
                    id={id}
                    name="token"
                    type={showToken ? "text" : "password"}
                    autoComplete="current-password"
                    autoFocus
                    className="field-input pr-10"
                    value={token}
                    onChange={(event) => {
                      setToken(event.target.value);
                      setError(null);
                    }}
                    aria-invalid={error !== null}
                    aria-describedby={error === null ? undefined : "signin-error"}
                    data-testid="signin-token"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setShowToken((current) => !current);
                    }}
                    aria-label={showToken ? "Hide token" : "Show token"}
                    className="absolute inset-y-0 right-0 grid w-9 place-items-center text-fg-muted transition-colors hover:text-fg"
                  >
                    {showToken ? (
                      <EyeSlash className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}
            </Field>

            {error !== null ? (
              <p
                id="signin-error"
                className="rounded-ui border border-storm/35 bg-storm/10 px-3 py-2 text-[11.5px] leading-snug text-storm"
              >
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submitting}
              className="w-full"
              data-testid="signin-submit"
            >
              {submitting ? "Signing in" : "Continue"}
            </Button>
          </form>

          <p className="mt-6 border-t border-line pt-4 text-[11px] leading-relaxed text-fg-muted">
            Agent tokens are separate. They authenticate the MCP server and CLI,
            never this browser.
          </p>
        </div>
      </section>
    </main>
  );
}
