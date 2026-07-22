import type { KeyboardEvent, PointerEvent } from "react";

// Shared drag-to-resize handle for side panels (results-sheet's agent/chart
// panels, model-diagram's chat/memo panel). Purely presentational: an absolutely
// positioned edge strip whose inner bar highlights on hover/focus and — when the
// consumer passes `active` — while a drag is in flight. Keyboard-accessible as an
// ARIA separator (Arrow/Home/End nudge the width via onResizeBy). The pointer-drag
// bookkeeping lives in the consumer so it can clamp against its own layout.
type PanelResizeHandleProps = {
  // Which edge of the panel the handle sits on. A "right"-edge handle grows the
  // panel when dragged right; a "left"-edge handle grows it when dragged left.
  side: "left" | "right";
  label: string;
  value: number;
  min: number;
  max: number;
  // True while a drag is in progress — keeps the bar highlighted through the drag.
  active?: boolean;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeBy: (deltaWidth: number) => void;
};

export function PanelResizeHandle({
  side,
  label,
  value,
  min,
  max,
  active = false,
  onPointerDown,
  onResizeBy,
}: PanelResizeHandleProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const leftArrowDelta = side === "left" ? 16 : -16;
    if (event.key === "ArrowLeft") onResizeBy(leftArrowDelta);
    else if (event.key === "ArrowRight") onResizeBy(-leftArrowDelta);
    else if (event.key === "Home") onResizeBy(min - value);
    else if (event.key === "End") onResizeBy(max - value);
    else return;
    event.preventDefault();
  };

  const className = [
    "panelResizeHandle",
    side === "left" ? "panelResizeHandleLeft" : "panelResizeHandleRight",
    active ? "panelResizeHandle--active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={className}
      type="button"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      onPointerDown={onPointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
