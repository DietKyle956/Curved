import { CircleNotch, X } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  initials,
} from "../lib/presentation.ts";
import type { Priority, Status } from "../lib/types.ts";

export function LogoMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M20.5 3.5a12 12 0 1 0 0 17"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border border-spice bg-spice text-canvas hover:border-spice/90 hover:bg-spice/90",
  secondary:
    "border border-line bg-elevated text-fg hover:border-line-strong hover:bg-elevated/80",
  ghost:
    "border border-transparent text-fg-secondary hover:border-line hover:bg-elevated hover:text-fg",
  danger:
    "border border-storm/40 bg-storm/10 text-storm hover:border-storm/60 hover:bg-storm/15",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2 text-[11px]",
  md: "h-8 gap-1.5 px-3 text-[12px]",
  lg: "h-9 gap-2 px-3.5 text-[13px]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-ui font-medium whitespace-nowrap transition-[background-color,border-color,color,transform,opacity] duration-150 select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <CircleNotch className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary";
  size?: "sm" | "md";
}

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  const dimension = size === "sm" ? "size-7" : "size-8";
  const tone =
    variant === "secondary"
      ? "border border-line bg-panel text-fg-secondary hover:border-line-strong hover:text-fg"
      : "border border-transparent text-fg-muted hover:border-line hover:bg-elevated hover:text-fg";
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-ui transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] ${dimension} ${tone} ${className}`}
      {...rest}
    >
      {icon}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-ui border border-line bg-elevated px-1 font-mono text-[10px] leading-none text-fg-secondary">
      {children}
    </kbd>
  );
}

export function StatusChip({
  status,
  className = "",
}: {
  status: Status;
  className?: string;
}) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-ui border px-1.5 py-1 font-mono text-[10px] leading-none tracking-[0.06em] uppercase ${tone.bg} ${tone.border} ${tone.text} ${className}`}
    >
      <span className={`size-1 rounded-[1px] ${tone.mark}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PriorityMark({
  priority,
  showLabel = false,
}: {
  priority: Priority;
  showLabel?: boolean;
}) {
  return (
    <span
      title={`Priority: ${PRIORITY_LABEL[priority]}`}
      className={`inline-flex items-center gap-1 font-mono text-[10px] leading-none ${PRIORITY_TONE[priority]}`}
    >
      <span aria-hidden="true">P{priority}</span>
      {showLabel ? (
        <span className="font-sans text-[11px] tracking-normal">
          {PRIORITY_LABEL[priority]}
        </span>
      ) : (
        <span className="sr-only">{PRIORITY_LABEL[priority]}</span>
      )}
    </span>
  );
}

export function AgentMark({
  name,
  active = false,
  className = "",
}: {
  name: string;
  active?: boolean;
  className?: string;
}) {
  const tone = active
    ? "border-spice/40 bg-spice/10 text-spice"
    : "border-line bg-elevated text-fg-secondary";
  return (
    <span
      title={name}
      className={`inline-grid size-5 shrink-0 place-items-center rounded-ui border font-mono text-[9px] leading-none ${tone} ${className}`}
    >
      {initials(name)}
    </span>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
  className?: string;
}

export function Field({ label, hint, error, children, className = "" }: FieldProps) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <label
        htmlFor={id}
        className="text-[11px] font-medium tracking-[0.01em] text-fg-secondary"
      >
        {label}
      </label>
      {children(id)}
      {error !== undefined ? (
        <p id={`${id}-error`} className="text-[11px] leading-snug text-storm">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="text-[11px] leading-snug text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <CircleNotch
      className={`animate-spin ${className}`}
      aria-hidden="true"
    />
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className = "",
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 py-10 text-center ${className}`}
    >
      <div className="mb-4 grid size-10 place-items-center rounded-ui border border-line bg-panel text-fg-muted">
        {icon}
      </div>
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {body !== undefined ? (
        <p className="mt-1.5 max-w-[36ch] text-[12px] leading-relaxed text-fg-muted">
          {body}
        </p>
      ) : null}
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <IconButton label={label} onClick={onClick} icon={<X className="size-4" />} />;
}
