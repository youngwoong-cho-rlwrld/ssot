import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

/**
 * Pointer-drag bookkeeping for resize handles. Call `startDrag(event, onMove)`
 * from a handle's onPointerDown: it captures the pointer, toggles `bodyClass`
 * on document.body for the duration of the drag, and invokes `onMove` with the
 * signed pointer delta (px) from the drag start on every move. Cleanup (release
 * capture, remove listeners, drop the body class) runs on pointerup/cancel and
 * on unmount.
 *
 * Per-drag state (start width, clamp bounds, direction) is captured by the
 * caller's `onMove` closure created at pointerdown, so the same hook drives a
 * single panel or several with flipped directions.
 */
export function useDragResize(bodyClass = "panelResizing") {
  const cleanupRef = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);

  const startDrag = useCallback(
    (
      event: PointerEvent<HTMLElement>,
      onMove: (deltaX: number, deltaY: number) => void,
    ) => {
      event.preventDefault();
      cleanupRef.current?.();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      target.setPointerCapture?.(pointerId);
      setDragging(true);
      document.body.classList.add(bodyClass);

      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        onMove(moveEvent.clientX - startX, moveEvent.clientY - startY);
      };
      const cleanup = () => {
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        document.body.classList.remove(bodyClass);
        setDragging(false);
        cleanupRef.current = null;
      };
      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("pointercancel", cleanup, { once: true });
    },
    [bodyClass],
  );

  useEffect(() => () => cleanupRef.current?.(), []);

  return { startDrag, dragging };
}
