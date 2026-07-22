import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  RefreshCcw,
  Upload,
  X,
} from "lucide-react";
import { SsotSelect } from "@ssot/ui/SsotSelect";
import {
  ApiError,
  createRun,
  getDiagram,
  getModels,
  getRun,
  runPageUrl,
  uploadPaper,
  validate,
} from "./api";
import { ModelSelect } from "./ModelSelect";
import { RunProgress } from "./RunProgress";
import type {
  DiagramDetail,
  ModelOption,
  PaperInput,
  RunSummary,
  Status,
} from "./types";

const STATUS_LABEL: Record<Status, string> = {
  running: "running",
  done: "ready",
  error: "error",
};

function runLabel(run: RunSummary, index: number, total: number): string {
  const when = new Date(run.created_at).toLocaleString();
  const ordinal = total - index; // newest first → highest number
  return `Run ${ordinal} · ${STATUS_LABEL[run.status]} · ${when}`;
}

interface Props {
  diagramId: number;
  runId: number;
  onSelectRun: (runId: number) => void;
  onRunStarted: (diagramId: number, runId: number) => void;
  onBack: () => void;
}

export function Viewer({
  diagramId,
  runId,
  onSelectRun,
  onRunStarted,
  onBack,
}: Props) {
  const [detail, setDetail] = useState<DiagramDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paperWarning, setPaperWarning] = useState<string | null>(null);
  const [reprovisioning, setReprovisioning] = useState(false);
  // Bumped when an in-viewer running run completes, to re-fetch the diagram so
  // the run flips to "done" and the rendered page replaces the progress view.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getDiagram(diagramId, controller.signal)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [diagramId, reloadNonce]);

  const runs = detail?.runs ?? [];
  const current = useMemo(
    () => runs.find((r) => r.run_id === runId) ?? null,
    [runs, runId],
  );

  // The run summary lacks paper_warning; fetch the detail for a mismatch banner.
  useEffect(() => {
    if (current?.paper_status !== "mismatch") {
      setPaperWarning(null);
      return;
    }
    const controller = new AbortController();
    getRun(runId, controller.signal)
      .then((r) => setPaperWarning(r.paper_warning ?? ""))
      .catch(() => setPaperWarning(""));
    return () => controller.abort();
  }, [runId, current?.paper_status]);

  const runOptions = runs.map((r, i) => ({
    value: String(r.run_id),
    label: runLabel(r, i, runs.length),
  }));

  return (
    <section className="panel viewer">
      <div className="panel__head viewer__head">
        <button
          type="button"
          className="ssot-icon-btn"
          onClick={onBack}
          title="Back"
          aria-label="Back to diagrams"
        >
          <ArrowLeft size={15} />
        </button>
        <h2 className="panel__title viewer__title">
          {current?.title || detail?.path || "Diagram"}
        </h2>
        <span className="viewer__spacer" />
        {runOptions.length > 1 && (
          <div className="viewer__runs">
            <SsotSelect
              value={String(runId)}
              onChange={(v) => onSelectRun(Number(v))}
              options={runOptions}
              aria-label="Run history"
            />
          </div>
        )}
        <button
          type="button"
          className="ssot-btn"
          onClick={() => setReprovisioning((v) => !v)}
        >
          <RefreshCcw size={14} /> Re-provision
        </button>
      </div>

      {current?.paper_status === "mismatch" && (
        <div className="viewer__banner">
          <AlertTriangle size={15} />
          <span>
            {paperWarning ||
              "The attached paper did not match this model — the diagram was built from code only, and paper-cited numbers are omitted."}
          </span>
        </div>
      )}

      {reprovisioning && current && (
        <ReprovisionForm
          diagramId={diagramId}
          cluster={current.cluster}
          initialPath={current.path}
          onClose={() => setReprovisioning(false)}
          onStarted={(newRunId) => {
            setReprovisioning(false);
            onRunStarted(diagramId, newRunId);
          }}
        />
      )}

      <div className="viewer__frame">
        {error ? (
          <div className="panel__status panel__status--err">{error}</div>
        ) : current && current.status === "running" ? (
          // Reconnect to the live stage stream (the backend replays past stage
          // events on connect, so the checklist restores) and swap in the
          // rendered diagram once the run completes.
          <RunProgress
            key={runId}
            embedded
            runId={runId}
            onDone={() => setReloadNonce((n) => n + 1)}
            onBack={onBack}
          />
        ) : current && current.status !== "done" ? (
          <div className="panel__status">
            This run is {STATUS_LABEL[current.status]}. Select a completed run to
            view its diagram.
          </div>
        ) : (
          <iframe
            key={runId}
            className="viewer__iframe"
            src={runPageUrl(runId)}
            title="Model diagram"
          />
        )}
      </div>
    </section>
  );
}

type PaperMode = "keep" | "none" | "url" | "pdf";

interface ReprovisionProps {
  diagramId: number;
  cluster: string;
  initialPath: string;
  onClose: () => void;
  onStarted: (runId: number) => void;
}

function ReprovisionForm({
  diagramId,
  cluster,
  initialPath,
  onClose,
  onStarted,
}: ReprovisionProps) {
  const [path, setPath] = useState(initialPath);
  const [paperMode, setPaperMode] = useState<PaperMode>("keep");
  const [paperUrl, setPaperUrl] = useState("");
  const [pdf, setPdf] = useState<{ ref: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    getModels(controller.signal)
      .then((m) => {
        setModels(m.models);
        setModel((prev) => prev || m.default);
      })
      .catch(() => {
        // keep the select empty; the backend default still applies
      });
    return () => controller.abort();
  }, []);

  const selectMode = useCallback((mode: PaperMode) => {
    setPaperMode(mode);
    setErr(null);
    if (mode !== "url") setPaperUrl("");
    if (mode !== "pdf") {
      setPdf(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const onPickPdf = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setErr(null);
    setPdf(null);
    try {
      const result = await uploadPaper(file);
      setPdf({ ref: result.paper_ref, name: result.filename });
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.detail || "The PDF could not be validated."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setUploading(false);
    }
  }, []);

  const onSubmit = useCallback(async () => {
    setErr(null);
    // "keep" leaves paper undefined so the backend reuses the prior run's paper;
    // "none" sends null to drop it; url/pdf attach a new one.
    let paper: PaperInput | null | undefined;
    if (paperMode === "keep") paper = undefined;
    else if (paperMode === "none") paper = null;
    else if (paperMode === "url") {
      if (!paperUrl.trim()) {
        setErr("Enter a paper URL.");
        return;
      }
      paper = { kind: "url", url: paperUrl.trim() };
    } else if (paperMode === "pdf") {
      if (!pdf) {
        setErr("Choose a PDF.");
        return;
      }
      paper = { kind: "pdf", paper_ref: pdf.ref };
    }

    const effectivePath = path.trim() || initialPath;
    setBusy(true);
    try {
      const check = await validate({
        cluster,
        path: effectivePath,
        paper: paper ?? null,
      });
      if (!check.ok) {
        setErr(check.detail);
        return;
      }
      const { run_id } = await createRun(diagramId, {
        cluster,
        path: path.trim() || undefined,
        paper,
        model: model || undefined,
      });
      onStarted(run_id);
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.detail || e.error || e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }, [paperMode, paperUrl, pdf, path, initialPath, cluster, model, diagramId, onStarted]);

  return (
    <form
      className="reprovision"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit();
      }}
    >
      <div className="reprovision__row">
        <label className="field field--grow">
          <span className="field__label">Model root path</span>
          <input
            className="ssot-input"
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
        {models.length > 0 && (
          <div className="field">
            <span className="field__label">Model</span>
            <ModelSelect value={model} options={models} onChange={setModel} />
          </div>
        )}
      </div>

      <div className="reprovision__row">
        <div className="segmented" role="tablist" aria-label="Paper source">
          {(["keep", "none", "url", "pdf"] as PaperMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={paperMode === mode}
              className={`segmented__opt${
                paperMode === mode ? " segmented__opt--on" : ""
              }`}
              onClick={() => selectMode(mode)}
            >
              {mode === "keep"
                ? "Keep paper"
                : mode === "none"
                  ? "Drop paper"
                  : mode === "url"
                    ? "URL"
                    : "PDF"}
            </button>
          ))}
        </div>

        {paperMode === "url" && (
          <input
            className="ssot-input"
            type="url"
            value={paperUrl}
            onChange={(e) => setPaperUrl(e.target.value)}
            placeholder="https://arxiv.org/abs/…"
            spellCheck={false}
          />
        )}

        {paperMode === "pdf" && (
          <div className="newdiag__pdf">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="ssot-sr-only"
              id="reprovision-pdf"
              onChange={(e) => void onPickPdf(e.target.files?.[0])}
            />
            <label htmlFor="reprovision-pdf" className="ssot-btn newdiag__pdf-btn">
              {uploading ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Upload size={14} />
              )}
              {pdf ? pdf.name : "Choose PDF…"}
            </label>
            {pdf && (
              <button
                type="button"
                className="ssot-icon-btn"
                onClick={() => selectMode("pdf")}
                title="Clear file"
                aria-label="Clear file"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {err && <div className="form__err">{err}</div>}

      <div className="reprovision__actions">
        <button type="button" className="ssot-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="submit"
          className="ssot-btn ssot-btn-primary"
          disabled={busy || uploading}
        >
          {busy ? <Loader2 size={14} className="spin" /> : null}
          Start run
        </button>
      </div>
    </form>
  );
}
