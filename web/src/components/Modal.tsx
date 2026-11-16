import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  /** Alignment, padding, overflow, and stacking for the backdrop layer. */
  overlayClassName?: string;
  /** Size, surface, and layout for the panel itself. */
  panelClassName: string;
  children: ReactNode;
}

/**
 * Centered dialog shell: dimmed backdrop, Escape and outside-click close, body
 * scroll lock, and a Tab focus cycle inside the panel. The panel content owns
 * its own header and footer.
 */
export function Modal({
  open,
  onClose,
  label,
  labelledBy,
  describedBy,
  overlayClassName = "",
  panelClassName,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    if (!panelRef.current?.contains(document.activeElement)) {
      panelRef.current?.focus();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) {
        return;
      }
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      if (document.activeElement === panelRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus !== null && previousFocus.isConnected && previousFocus !== panelRef.current) {
        previousFocus.focus();
      }
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className={`fixed inset-0 z-[60] flex justify-center bg-canvas/80 backdrop-blur-[2px] ${overlayClassName}`}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onClose();
            }
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={label}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            className={`${panelClassName} outline-none`}
            initial={reduce ? false : { opacity: 0, y: 8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: 6, scale: 0.99 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
