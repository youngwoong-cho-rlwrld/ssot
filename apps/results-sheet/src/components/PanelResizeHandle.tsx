import type { KeyboardEvent, PointerEvent } from "react";

type PanelResizeHandleProps = {
  side: "left" | "right";
  label: string;
  value: number;
  min: number;
  max: number;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeBy: (deltaWidth: number) => void;
};

export function PanelResizeHandle({
  side,
  label,
  value,
  min,
  max,
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

  return (
    <button
      className={`panelResizeHandle panelResizeHandle${side === "left" ? "Left" : "Right"}`}
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
