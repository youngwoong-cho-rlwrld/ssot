"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";

// Shared agent/LLM model picker — the trigger + listbox grammar originally in
// OpenClaw's ModelSwitcher, now the single source for every app's model picker
// (OpenClaw, model-diagram, results-sheet). Purely presentational: the option
// list, current value, and per-pick behavior come from the consumer. App-specific
// chrome (e.g. OpenClaw's per-provider API-key form) rides in the `header` /
// `children` / `footer` slots and its own controlled-open state — so this stays a
// dumb widget and no app's behavior is baked in. Styling is @ssot/theme/model-switcher.css.
//
// The popover is PORTALED to <body> with fixed positioning (same approach as
// SsotSelect) so it escapes any panel's overflow clipping, and it auto-flips ABOVE
// the trigger when there is not enough room below (e.g. the picker sits at the
// bottom of the chat composer), with a dynamic max-height so it never overflows
// the viewport in either direction.
export interface ModelSwitcherOption {
  id: string;
  label: string;
  // Right-aligned muted meta (OpenClaw shows the provider; model-diagram the id).
  provider?: string;
  // Small trailing badge, e.g. "missing key" for an unauthenticated provider.
  flag?: string;
  // Per-item disabled (OpenClaw greys the list while a mutation is in flight; the
  // shared catalog greys entries a backend can't run).
  disabled?: boolean;
  // Tooltip shown on a disabled item (e.g. "not configured on this host").
  disabledReason?: string;
}

export interface ModelSwitcherProps {
  value: string;
  options: ModelSwitcherOption[];
  onChange: (id: string) => void;
  disabled?: boolean; // disables the trigger button
  title?: string;
  // Override the trigger text; otherwise it is the selected option's label.
  triggerLabel?: string;
  // Trigger text when `value` matches no option (else falls back to the raw value).
  fallbackLabel?: string;
  className?: string;
  // Controlled open state. Supply both to keep the popover open across a pick
  // (OpenClaw swaps the list for its auth form on an unavailable model); omit to
  // let the component own open state and auto-close on a pick / outside click.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Popover slots. `header` renders above the content, `footer` below; `children`
  // REPLACES the option list entirely when provided.
  header?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}

// Inline icons in lucide's geometry so @ssot/ui carries no icon dependency (a
// consumer need not ship lucide-react — results-sheet uses tabler). Visually
// identical to the lucide <Cpu/ChevronDown/Check> the pickers used before.
function Icon({ size, children }: { size: number; children: ReactNode }) {
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
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const CPU = (
  <Icon size={15}>
    <rect width="16" height="16" x="4" y="4" rx="2" />
    <rect width="6" height="6" x="9" y="9" rx="1" />
    <path d="M15 2v2" />
    <path d="M15 20v2" />
    <path d="M2 15h2" />
    <path d="M2 9h2" />
    <path d="M20 15h2" />
    <path d="M20 9h2" />
    <path d="M9 2v2" />
    <path d="M9 20v2" />
  </Icon>
);
const CHEVRON = (
  <Icon size={13}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
const CHECK = (
  <Icon size={13}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

type PopoverPosition = {
  left: number;
  top: number;
  placement: "below" | "above";
  maxHeight: number;
};

export function ModelSwitcher({
  value,
  options,
  onChange,
  disabled,
  title = "Model",
  triggerLabel,
  fallbackLabel,
  className,
  open: openProp,
  onOpenChange,
  header,
  children,
  footer,
}: ModelSwitcherProps) {
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? openProp : openState;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange?.(next);
    else setOpenState(next);
  };

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const panelHeight = popRef.current?.offsetHeight ?? 0;
    const panelWidth = popRef.current?.offsetWidth ?? 320;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    // Flip up only when the panel does not fit below AND there is more room above.
    const above = panelHeight > spaceBelow && spaceAbove > spaceBelow;
    let left = rect.left;
    if (left + panelWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - panelWidth);
    }
    setPos({
      left,
      top: above ? rect.top - gap : rect.bottom + gap,
      placement: above ? "above" : "below",
      maxHeight: Math.max(120, above ? spaceAbove : spaceBelow),
    });
  };

  // Measure + place after the popover is in the DOM (useLayoutEffect runs before
  // paint, so no visible jump); clear when closed.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options]);

  // Reposition on scroll/resize, and close on an outside click (checking the
  // portaled popover too, since it is no longer a DOM descendant of the trigger).
  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const current = options.find((option) => option.id === value);
  const label = triggerLabel ?? current?.label ?? fallbackLabel ?? value;

  const pick = (id: string) => {
    onChange(id);
    // Controlled consumers decide when to close (OpenClaw keeps it open for auth).
    if (!controlled) setOpen(false);
  };

  const popStyle: CSSProperties = {
    position: "fixed",
    left: pos?.left ?? 0,
    top: pos?.top ?? 0,
    transform: pos?.placement === "above" ? "translateY(-100%)" : undefined,
    maxHeight: pos ? pos.maxHeight : undefined,
    // Hidden for the one pre-measure frame so a misplaced popover never flashes.
    visibility: pos ? "visible" : "hidden",
  };

  return (
    <div className={`model-switcher${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="model-switcher__btn"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {CPU}
        <span className="model-switcher__current">{label}</span>
        {CHEVRON}
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div ref={popRef} className="model-switcher__pop" role="listbox" style={popStyle}>
            {header}
            {children ?? (
              <ul className="model-switcher__list">
                {options.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.id === value}
                      disabled={option.disabled}
                      title={option.disabled ? option.disabledReason : undefined}
                      className={`model-switcher__item${
                        option.id === value ? " model-switcher__item--active" : ""
                      }`}
                      onClick={() => pick(option.id)}
                    >
                      <span className="model-switcher__check">
                        {option.id === value && CHECK}
                      </span>
                      <span className="model-switcher__name">{option.label}</span>
                      {option.provider !== undefined && (
                        <span className="model-switcher__provider">{option.provider}</span>
                      )}
                      {option.flag && (
                        <span className="model-switcher__missing">{option.flag}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {footer}
          </div>,
          document.body,
        )}
    </div>
  );
}
