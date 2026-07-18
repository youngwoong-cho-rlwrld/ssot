"use client";

import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SsotSelectOption = { value: string; label: string };

type SsotSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SsotSelectOption[];
  variant?: "default" | "pill";
  className?: string;
  title?: string;
  "aria-label"?: string;
};

type PanelPosition = {
  left: number;
  top: number;
  width: number;
  placement: "below" | "above";
};

/**
 * Shared SSOT listbox: a custom-rendered replacement for native <select> so the
 * OPEN dropdown matches the canonical .ssot-listbox panel across every app
 * (mirrors apps/urdf-viewer/src/SsotSelect.tsx, the reference implementation).
 * The trigger is styled like .ssot-select-trigger; the panel is portaled to
 * <body> and positioned with fixed coordinates so it escapes the scroll/overflow
 * clipping of the surrounding panels.
 */
export function SsotSelect({
  value,
  onChange,
  options,
  variant = "default",
  className,
  title,
  "aria-label": ariaLabel,
}: SsotSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const panel = panelRef.current;
    const panelHeight = panel?.offsetHeight ?? 0;
    const panelWidth = panel?.offsetWidth ?? rect.width;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = panelHeight > 0 && spaceBelow < panelHeight + gap && rect.top > spaceBelow;
    let left = rect.left;
    if (left + panelWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - 8 - panelWidth);
    }
    setPos({
      left,
      top: placeAbove ? rect.top - gap : rect.bottom + gap,
      width: rect.width,
      placement: placeAbove ? "above" : "below",
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    setHighlight(selectedIndex);
    updatePosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-opt-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, listboxId]);

  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlight((current) => Math.min(options.length - 1, current + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => Math.max(0, current - 1));
        break;
      case "Home":
        event.preventDefault();
        setHighlight(0);
        break;
      case "End":
        event.preventDefault();
        setHighlight(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(highlight);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const triggerClass = ["ssot-select-trigger", variant === "pill" ? "pill" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-opt-${highlight}` : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="ssot-select-value">{selected?.label ?? ""}</span>
        <IconChevronDown className="ssot-select-arrow" size={variant === "pill" ? 13 : 14} stroke={2} aria-hidden />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            className="ssot-listbox"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              minWidth: pos.width,
              maxWidth: "calc(100vw - 16px)",
              transform: pos.placement === "above" ? "translateY(-100%)" : undefined,
            }}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <div
                  key={option.value}
                  id={`${listboxId}-opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className="ssot-option"
                  data-highlighted={index === highlight ? "" : undefined}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  {isSelected && (
                    <span className="ssot-option-check">
                      <IconCheck size={14} stroke={2.2} aria-hidden />
                    </span>
                  )}
                  {option.label}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
