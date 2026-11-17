import {
  CheckCircle,
  Info,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type { ToastItem, ToastKind } from "../domain/types.ts";

const TONE: Record<ToastKind, string> = {
  success: "text-oasis",
  error: "text-storm",
  info: "text-fremen",
};

const ICON = {
  success: CheckCircle,
  error: WarningCircle,
  info: Info,
};

export function Toasts({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[70] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 md:right-4 md:bottom-4"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {items.map((item) => {
          const Icon = ICON[item.kind];
          return (
            <motion.div
              key={item.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: 6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-auto flex items-start gap-2.5 rounded-ui border border-line bg-elevated px-3 py-2.5 shadow-float"
              data-testid="toast"
              data-kind={item.kind}
            >
              <Icon
                className={`mt-px size-4 shrink-0 ${TONE[item.kind]}`}
                aria-hidden="true"
              />
              <p className="min-w-0 flex-1 text-[12px] leading-snug text-fg">
                {item.message}
              </p>
              <button
                type="button"
                onClick={() => {
                  onDismiss(item.id);
                }}
                aria-label="Dismiss notification"
                className="-m-1 grid size-6 shrink-0 place-items-center rounded-ui text-fg-muted transition-colors hover:bg-panel hover:text-fg"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
