import { WarningCircle } from "@phosphor-icons/react";

import { Button, LogoMark, Spinner } from "./ui.tsx";

export function BootScreen({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4">
      <LogoMark className="size-7 text-spice" />
      <div className="flex items-center gap-2 text-[11px] text-fg-muted">
        <Spinner className="size-3.5" />
        {label}
      </div>
    </div>
  );
}

export function BootError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-5">
      <div className="w-full max-w-sm rounded-ui border border-line bg-panel p-5">
        <WarningCircle className="size-5 text-storm" aria-hidden="true" />
        <h1 className="mt-3 text-[16px] font-semibold tracking-[-0.01em] text-fg">
          Cannot reach the server
        </h1>
        <p className="mt-1.5 text-[12px] leading-relaxed text-fg-secondary">
          {message}
        </p>
        <Button variant="secondary" size="md" className="mt-4" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
