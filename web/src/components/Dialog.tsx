import type { ReactNode } from "react";

import { CloseButton } from "./ui.tsx";
import { Modal } from "./Modal.tsx";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
}

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
}: DialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="dialog-title"
      describedBy={description === undefined ? undefined : "dialog-description"}
      overlayClassName="items-start overflow-y-auto px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 sm:items-center sm:p-6"
      panelClassName={`my-auto w-full ${SIZES[size]} rounded-ui border border-line bg-panel shadow-float`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5">
        <div>
          <h2
            id="dialog-title"
            className="text-[14px] font-semibold tracking-[-0.01em] text-fg"
          >
            {title}
          </h2>
          {description !== undefined ? (
            <p
              id="dialog-description"
              className="mt-1 text-[11.5px] leading-snug text-fg-muted"
            >
              {description}
            </p>
          ) : null}
        </div>
        <CloseButton label="Close dialog" onClick={onClose} />
      </div>
      <div className="px-4 py-4">{children}</div>
    </Modal>
  );
}
