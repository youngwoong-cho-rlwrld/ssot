import { useCallback, useEffect, useState } from "react";
import { FileText, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { deleteDiagram, getDiagrams } from "./api";
import type { DiagramListItem, RunSummary, Status } from "./types";

const STATUS_LABEL: Record<Status, string> = {
  running: "Running",
  done: "Ready",
  error: "Error",
};

function statusModifier(status: Status): string {
  if (status === "done") return "ok";
  if (status === "running") return "run";
  return "err";
}

function shortCommit(hash: string | null): string | null {
  return hash ? hash.slice(0, 10) : null;
}

interface Props {
  reloadNonce: number;
  onNew: () => void;
  onOpen: (diagramId: number, runId: number) => void;
  onRerun: (diagramId: number, latestRun: RunSummary) => void;
}

export function DiagramList({ reloadNonce, onNew, onOpen, onRerun }: Props) {
  const [diagrams, setDiagrams] = useState<DiagramListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    getDiagrams(signal)
      .then((rows) => {
        setDiagrams(rows);
        setError(null);
      })
      .catch((err) => {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, reloadNonce]);

  const onDelete = useCallback(async (id: number) => {
    try {
      await deleteDiagram(id);
      setDiagrams((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDelete(null);
    }
  }, []);

  return (
    <section className="panel diagrams">
      <div className="panel__head">
        <h2 className="panel__title">Diagrams</h2>
        {diagrams.length > 0 && (
          <span className="panel__count">{diagrams.length}</span>
        )}
        <button
          type="button"
          className="ssot-icon-btn diagrams__refresh"
          onClick={() => load()}
          title="Refresh"
          aria-label="Refresh diagrams"
        >
          <RefreshCw size={15} className={loading ? "spin" : undefined} />
        </button>
        <button type="button" className="ssot-btn ssot-btn-primary" onClick={onNew}>
          <Plus size={15} /> New diagram
        </button>
      </div>

      <div className="panel__body diagrams__body">
        {error && <div className="panel__status panel__status--err">{error}</div>}
        {loading && diagrams.length === 0 && !error && (
          <div className="panel__status">Loading diagrams…</div>
        )}
        {!loading && diagrams.length === 0 && !error && (
          <div className="panel__status">
            No diagrams yet. Create one to analyze a model.
          </div>
        )}

        <ul className="diagram-list">
          {diagrams.map((d) => {
            const run = d.latest_run;
            return (
              <li key={d.id} className="diagram-row">
                <button
                  type="button"
                  className="diagram"
                  onClick={() => onOpen(d.id, run.run_id)}
                >
                  <div className="diagram__top">
                    <span className={`status status--${statusModifier(run.status)}`}>
                      {STATUS_LABEL[run.status]}
                    </span>
                    <span className="diagram__cluster">{run.cluster}</span>
                    {run.has_paper && (
                      <span
                        className={`paper-badge${
                          run.paper_status === "mismatch" ? " paper-badge--warn" : ""
                        }`}
                        title={
                          run.paper_status === "mismatch"
                            ? "Paper attached: did not match the code"
                            : "Paper attached"
                        }
                      >
                        <FileText size={12} /> Paper
                      </span>
                    )}
                    {shortCommit(run.commit_hash) && (
                      <span className="diagram__commit">
                        {shortCommit(run.commit_hash)}
                      </span>
                    )}
                  </div>
                  {run.title && <div className="diagram__title">{run.title}</div>}
                  <div className="diagram__path">{d.path}</div>
                  {d.memo.trim() && (
                    <div className="diagram__memo" title={d.memo}>
                      {d.memo.trim()}
                    </div>
                  )}
                </button>

                <div className="diagram__actions">
                  <button
                    type="button"
                    className="diagram__act"
                    onClick={() => onRerun(d.id, run)}
                    title="Re-run this diagram"
                    aria-label="Re-run this diagram"
                  >
                    <RotateCw size={14} />
                  </button>
                  {pendingDelete === d.id ? (
                    <div className="diagram__confirm">
                      <span className="diagram__confirm-msg">Delete?</span>
                      <button
                        type="button"
                        className="diagram__confirm-yes"
                        onClick={() => onDelete(d.id)}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="diagram__confirm-no"
                        onClick={() => setPendingDelete(null)}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="diagram__act diagram__act--del"
                      onClick={() => setPendingDelete(d.id)}
                      title="Delete diagram"
                      aria-label="Delete diagram"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
