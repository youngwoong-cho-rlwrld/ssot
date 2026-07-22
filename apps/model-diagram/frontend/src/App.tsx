import { useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { DiagramList } from "./DiagramList";
import { NewDiagram } from "./NewDiagram";
import { RunProgress } from "./RunProgress";
import { Viewer } from "./Viewer";
import { resumeActiveRuns, startRunWatcher } from "./lib/run-watcher";

// Simple client-side view state — the suite's Vite apps (urdf, session-viewer)
// carry no router, so neither does this one.
type View =
  | { name: "list" }
  // `prefill` re-runs an existing diagram: NewDiagram submits to
  // POST /api/diagrams/:id/runs instead of creating a new diagram.
  | { name: "new"; prefill?: { diagramId: number; cluster: string; path: string } }
  | { name: "run"; diagramId: number; runId: number }
  | { name: "viewer"; diagramId: number; runId: number };

export default function App() {
  const [view, setView] = useState<View>({ name: "list" });
  // Bumped whenever a run finishes or a diagram is deleted, so the list
  // refetches when we return to it.
  const [listNonce, setListNonce] = useState(0);
  const portalUrl = import.meta.env.VITE_SSOT_PORTAL_URL ?? "/";

  const openViewer = useCallback((diagramId: number, runId: number) => {
    setView({ name: "viewer", diagramId, runId });
  }, []);

  // Resume toast notifications for any runs that were still generating when the
  // app was last open (mirrors train-eval's resumeActiveCopies on mount).
  useEffect(() => {
    resumeActiveRuns(openViewer);
  }, [openViewer]);

  // A new run: start its persistent toast watcher (which localStorage-tracks it
  // for resume-after-reload) and open the full-screen progress view.
  const startRun = useCallback(
    (diagramId: number, runId: number) => {
      startRunWatcher({ runId, diagramId }, openViewer);
      setView({ name: "run", diagramId, runId });
    },
    [openViewer],
  );

  const backToList = useCallback(() => {
    setListNonce((n) => n + 1);
    setView({ name: "list" });
  }, []);

  return (
    <div className="ssot-app app">
      <header className="ssot-header">
        <a className="ssot-brand" href={portalUrl}>
          SSOT
        </a>
        <span className="ssot-sep">/</span>
        <span className="ssot-app-name">Model Diagram</span>
        <span className="ssot-header-spacer"></span>
        <ssot-theme-toggle></ssot-theme-toggle>
        <ssot-user></ssot-user>
      </header>

      <main className="app__main">
        {view.name === "list" && (
          <DiagramList
            reloadNonce={listNonce}
            onNew={() => setView({ name: "new" })}
            onOpen={openViewer}
            onRerun={(diagramId, run) =>
              setView({
                name: "new",
                prefill: { diagramId, cluster: run.cluster, path: run.path },
              })
            }
          />
        )}

        {view.name === "new" && (
          <NewDiagram
            prefill={view.prefill}
            onCancel={backToList}
            onStarted={startRun}
          />
        )}

        {view.name === "run" && (
          <RunProgress
            key={view.runId}
            runId={view.runId}
            onDone={() => openViewer(view.diagramId, view.runId)}
            onBack={backToList}
          />
        )}

        {view.name === "viewer" && (
          <Viewer
            key={view.runId}
            diagramId={view.diagramId}
            runId={view.runId}
            onSelectRun={(runId) => openViewer(view.diagramId, runId)}
            onRunStarted={startRun}
            onBack={backToList}
          />
        )}
      </main>

      <Toaster position="bottom-right" richColors visibleToasts={9} />
    </div>
  );
}
