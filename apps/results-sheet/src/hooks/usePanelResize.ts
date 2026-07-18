import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent,
  type RefCallback,
  type SetStateAction,
} from "react";

type ResizablePanel = "agent" | "chart";

type PanelState = {
  open: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  setWidth: Dispatch<SetStateAction<number>>;
};

type PanelResizeConfig = {
  agent: PanelState;
  chart: PanelState;
  tableMinWidth: number;
  workspaceGap: number;
};

export function usePanelResize(config: PanelResizeConfig): {
  workspaceRef: RefCallback<HTMLDivElement>;
  resizingPanel: ResizablePanel | null;
  startResize: (panel: ResizablePanel, event: PointerEvent<HTMLButtonElement>) => void;
  resizeBy: (panel: ResizablePanel, deltaWidth: number) => void;
} {
  const configRef = useRef(config);
  configRef.current = config;
  const workspaceElementRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [resizingPanel, setResizingPanel] = useState<ResizablePanel | null>(null);

  const workspaceRef = useCallback<RefCallback<HTMLDivElement>>((element) => {
    workspaceElementRef.current = element;
  }, []);

  const panelState = useCallback((panel: ResizablePanel) => {
    const current = configRef.current;
    return panel === "agent" ? current.agent : current.chart;
  }, []);

  const maxPanelWidth = useCallback((panel: ResizablePanel, measuredWidth?: number) => {
    const currentConfig = configRef.current;
    const current = panel === "agent" ? currentConfig.agent : currentConfig.chart;
    const other = panel === "agent" ? currentConfig.chart : currentConfig.agent;
    const width = measuredWidth
      ?? workspaceElementRef.current?.getBoundingClientRect().width
      ?? window.innerWidth;
    const available = width
      - (other.open ? other.width : 0)
      - currentConfig.tableMinWidth
      - currentConfig.workspaceGap;
    return Math.max(current.minWidth, Math.min(current.maxWidth, available));
  }, []);

  const resizeBy = useCallback((panel: ResizablePanel, deltaWidth: number) => {
    const current = panelState(panel);
    current.setWidth((width) => clamp(width + deltaWidth, current.minWidth, maxPanelWidth(panel)));
  }, [maxPanelWidth, panelState]);

  const startResize = useCallback((panel: ResizablePanel, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    cleanupRef.current?.();

    const current = panelState(panel);
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = current.width;
    const maximumWidth = maxPanelWidth(panel);
    target.setPointerCapture?.(pointerId);
    setResizingPanel(panel);
    document.body.classList.add("panelResizing");

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const pointerDelta = moveEvent.clientX - startX;
      const widthDelta = panel === "agent" ? pointerDelta : -pointerDelta;
      current.setWidth(clamp(startWidth + widthDelta, current.minWidth, maximumWidth));
    };
    const cleanup = () => {
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.classList.remove("panelResizing");
      setResizingPanel(null);
      cleanupRef.current = null;
    };
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }, [maxPanelWidth, panelState]);

  useEffect(() => () => cleanupRef.current?.(), []);

  return { workspaceRef, resizingPanel, startResize, resizeBy };
}

function clamp(value: number, min: number, max: number) {
  return Math.round(Math.min(Math.max(value, min), max));
}
