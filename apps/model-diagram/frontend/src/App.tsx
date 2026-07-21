import { useCallback, useState } from "react";
import { DiagramList } from "./DiagramList";
import { NewDiagram } from "./NewDiagram";
import { RunProgress } from "./RunProgress";
import { Viewer } from "./Viewer";

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

  const openRun = useCallback((diagramId: number, runId: number) => {
    setView({ name: "run", diagramId, runId });
  }, []);

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
            onStarted={(diagramId, runId) => openRun(diagramId, runId)}
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
            onRunStarted={openRun}
            onBack={backToList}
          />
        )}
      </main>
    </div>
  );
}
