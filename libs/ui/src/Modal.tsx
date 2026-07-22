"use client";

import { useEffect } from "react";
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const panelClass = ["modal", className].filter(Boolean).join(" ");

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
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
