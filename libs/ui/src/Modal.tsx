"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

type ModalProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Extra class(es) on the panel, e.g. "instructions" or "modal--confirm". */
  className?: string;
  /** Accessible dialog label; defaults to `title`. */
  ariaLabel?: string;
};

// Inline close (X) icon so @ssot/ui carries zero runtime deps beyond react.
// Geometry matches the lucide X the apps used before (24×24, stroke, round caps),
// so it renders identically inside .ssot-icon-btn (inherits currentColor).
function CloseIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * Canonical SSOT modal: a centered overlay panel with a titled head + close
 * button, dismissed by clicking the backdrop or pressing Escape. Body content is
 * the children. Styling comes from @ssot/theme/modal.css (which the consuming app
 * imports) — this is the single shared source across apps.
 *
 * The "use client" directive is harmless under Vite and required for Next.js
 * server components.
 */
export function Modal({ title, onClose, children, className, ariaLabel }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape to dismiss + a focus trap so Tab cycles inside the dialog (behavior the
  // radix/shadcn dialogs some apps migrated from provided). Focus moves into the
  // panel on open and returns to the trigger on close; body scroll is locked while
  // open. All additive over escape/backdrop, so every consumer benefits uniformly.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const focusable = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null || el === document.activeElement)
        : [];

    // Focus the first field (skip the close button) so the dialog is keyboard-ready.
    const first = focusable().find((el) => el.getAttribute("aria-label") !== "Close");
    (first ?? panel)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstEl || active === panel)) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const panelClass = ["modal", className].filter(Boolean).join(" ");

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="ssot-icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
