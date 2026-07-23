import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCcw,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { SsotSelect } from "@ssot/ui/SsotSelect";
import { PanelResizeHandle } from "@ssot/ui/PanelResizeHandle";
import { ChatPanel } from "./ChatPanel";
import { requestCancelConfirm } from "./lib/cancel-bus";
import {
  ApiError,
  createRun,
  getDiagram,
  getModels,
  getRun,
  runPageUrl,
  updateDiagramMemo,
  uploadPaper,
  validate,
} from "./api";
import { ModelSwitcher } from "@ssot/ui/ModelSwitcher";
import { resolveCatalog } from "@ssot/ui/models-catalog";
import { CHAT_PANEL_WIDTH } from "@ssot/ui/chat-panel";
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

// Left chat/memo panel width — drag-resizable and persisted. Default/min/max come
// from the shared @ssot/ui constant so this and results-sheet's chat panel can't
// drift. The storage key is versioned (.v2) so a stale saved width from the old
// 360 default is discarded and everyone lands on the shared 340 default.
const LEFT_MIN_WIDTH = CHAT_PANEL_WIDTH.min;
const LEFT_MAX_WIDTH = CHAT_PANEL_WIDTH.max;
const LEFT_DEFAULT_WIDTH = CHAT_PANEL_WIDTH.default;
const LEFT_DIAGRAM_MIN = 360; // reserve for the diagram so the panel can't swallow it
const LEFT_WIDTH_KEY = "md.viewer.leftWidth.v2";

function clampWidth(width: number, max: number): number {
  return Math.round(Math.min(Math.max(width, LEFT_MIN_WIDTH), max));
}

function loadLeftWidth(): number {
  if (typeof window === "undefined") return LEFT_DEFAULT_WIDTH;
  const raw = Number(window.localStorage.getItem(LEFT_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0
    ? clampWidth(raw, LEFT_MAX_WIDTH)
    : LEFT_DEFAULT_WIDTH;
}

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
  // Left-panel section states — collapsible strips (OpenClaw LIVE LOG grammar).
  // Chat opens by default on a done run (the primary action); memo stays collapsed.
  const [chatOpen, setChatOpen] = useState(true);
  const [memoOpen, setMemoOpen] = useState(false);
  // Agent-output pane state, owned here so its toggle can live in the viewer
  // header; wired down to the embedded RunProgress (running runs only).
  const [outputOpen, setOutputOpen] = useState(false);
  // Bumped when an in-viewer running run completes, to re-fetch the diagram so
  // the run flips to "done" and the rendered page replaces the progress view.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Resizable left-panel width (persisted). resizing keeps the drag handle lit.
  const [leftWidth, setLeftWidth] = useState<number>(loadLeftWidth);
  const [resizing, setResizing] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    window.localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth));
  }, [leftWidth]);

  // Largest the panel may grow to right now: capped by LEFT_MAX_WIDTH and by
  // leaving the diagram at least LEFT_DIAGRAM_MIN of the split's measured width.
  const maxLeftWidth = useCallback(() => {
    const total = splitRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(LEFT_MIN_WIDTH, Math.min(LEFT_MAX_WIDTH, total - LEFT_DIAGRAM_MIN));
  }, []);

  const resizeLeftBy = useCallback(
    (delta: number) => {
      const max = maxLeftWidth();
      setLeftWidth((w) => clampWidth(w + delta, max));
    },
    [maxLeftWidth],
  );

  const startLeftResize = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      resizeCleanupRef.current?.();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = leftWidth;
      const max = maxLeftWidth();
      target.setPointerCapture?.(pointerId);
      setResizing(true);
      document.body.classList.add("panelResizing");

      // Panel is on the left with the handle on its right edge: drag right grows it.
      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        setLeftWidth(clampWidth(startWidth + (moveEvent.clientX - startX), max));
      };
      const cleanup = () => {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        document.body.classList.remove("panelResizing");
        setResizing(false);
        resizeCleanupRef.current = null;
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", cleanup, { once: true });
      window.addEventListener("pointercancel", cleanup, { once: true });
    },
    [leftWidth, maxLeftWidth],
  );

  useEffect(() => () => resizeCleanupRef.current?.(), []);

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

  // Collapse the output pane when switching runs.
  useEffect(() => {
    setOutputOpen(false);
  }, [runId]);

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
        {current?.status === "running" && (
          <button
            type="button"
            className="ssot-icon-btn"
            onClick={() => requestCancelConfirm(runId)}
            title="Cancel run"
            aria-label="Cancel run"
          >
            <Ban size={15} />
          </button>
        )}
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
        {(current?.status === "running" || current?.status === "error") && (
          <button
            type="button"
            className={`ssot-icon-btn${outputOpen ? " ssot-icon-btn--on" : ""}`}
            onClick={() => setOutputOpen((v) => !v)}
            title={outputOpen ? "Hide agent output" : "Show agent output"}
            aria-label={outputOpen ? "Hide agent output" : "Show agent output"}
            aria-pressed={outputOpen}
          >
            <Terminal size={15} />
          </button>
        )}
      </div>

      {current?.paper_status === "mismatch" && (
        <div className="viewer__banner">
          <AlertTriangle size={15} />
          <span>
            {paperWarning ||
              "The attached paper did not match this model, so the diagram was built from code only, and paper-cited numbers are omitted."}
          </span>
        </div>
      )}

      {reprovisioning && current && (
        <ReprovisionForm
          diagramId={diagramId}
          cluster={current.cluster}
          initialPath={current.path}
          anchorRunId={current.run_id}
          paperAttached={current.has_paper}
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
        ) : current && (current.status === "running" || current.status === "error") ? (
          // Running: reconnect to the live stage stream (the backend replays past
          // stage events on connect, so the checklist restores) and swap in the
          // rendered diagram once the run completes. Errored: the same embedded view
          // renders the failure notice (kind/detail/hint, or the neutral cancelled
          // notice) and its agent-output toggle, so the user can see what happened
          // instead of a bare "this run is error" placeholder.
          <RunProgress
            key={runId}
            embedded
            runId={runId}
            outputOpen={outputOpen}
            onOutputToggle={() => setOutputOpen((v) => !v)}
            onDone={() => setReloadNonce((n) => n + 1)}
            onBack={onBack}
          />
        ) : (
          // Done: an always-present LEFT panel of collapsible sections
          // (chat + memo, OpenClaw LIVE LOG grammar) | the diagram fills the rest.
          // Stacks on narrow widths.
          <div className="viewer__split" ref={splitRef}>
            <div
              className="viewer__left"
              style={{ "--viewer-left-width": `${leftWidth}px` } as CSSProperties}
            >
              <PanelResizeHandle
                side="right"
                label="Resize chat and memo panel"
                value={leftWidth}
                min={LEFT_MIN_WIDTH}
                max={LEFT_MAX_WIDTH}
                active={resizing}
                onPointerDown={startLeftResize}
                onResizeBy={resizeLeftBy}
              />
              <ChatPanel
                key={`chat-${runId}`}
                runId={runId}
                open={chatOpen}
                onToggle={() => setChatOpen((v) => !v)}
                onRevision={(newRunId) => {
                  // A revision is a new sibling run: refresh + switch to it.
                  setReloadNonce((n) => n + 1);
                  onSelectRun(newRunId);
                }}
              />
              {detail && (
                <CollapsibleSection
                  title="Memo"
                  className="viewer__memo-section"
                  open={memoOpen}
                  onToggle={() => setMemoOpen((v) => !v)}
                >
                  <MemoField key={diagramId} diagramId={diagramId} initial={detail.memo} />
                </CollapsibleSection>
              )}
            </div>
            <div className="viewer__diagram">
              <iframe
                key={runId}
                className="viewer__iframe"
                src={runPageUrl(runId)}
                title="Model diagram"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// A collapsible left-panel section mirroring OpenClaw's LIVE LOG grammar: a
// borderless chevron+uppercase-title header strip that toggles the body; collapsed
// shows only the strip.
function CollapsibleSection({
  title,
  open,
  onToggle,
  className,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`panel vsection ${className ?? ""} ${open ? "vsection--open" : "vsection--closed"}`}
    >
      <div className="panel__head vsection__head">
        <button
          type="button"
          className="vsection__toggle"
          onClick={onToggle}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <h3 className="panel__title">{title}</h3>
        </button>
      </div>
      {open && children}
    </section>
  );
}

type PaperMode = "keep" | "none" | "url" | "pdf";

interface ReprovisionProps {
  diagramId: number;
  cluster: string;
  initialPath: string;
  anchorRunId: number;
  paperAttached: boolean;
  onClose: () => void;
  onStarted: (runId: number) => void;
}

function ReprovisionForm({
  diagramId,
  cluster,
  initialPath,
  anchorRunId,
  paperAttached,
  onClose,
  onStarted,
}: ReprovisionProps) {
  const [path, setPath] = useState(initialPath);
  // Default "keep" → the request omits `paper`, so the backend inherits the anchor
  // run's paper (attached or none). "none" removes it; url/pdf replaces it.
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
        anchor_run_id: anchorRunId,
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
  }, [paperMode, paperUrl, pdf, path, initialPath, cluster, model, diagramId, anchorRunId, onStarted]);

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
            <ModelSwitcher
              value={model}
              options={resolveCatalog(models.map((m) => ({ key: m.id })))}
              onChange={setModel}
              title="Generation model"
            />
          </div>
        )}
      </div>

      <div className="reprovision__row">
        <span className="reprovision__paper-state">
          Paper: {paperAttached ? "attached" : "none"}
        </span>
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
                ? paperAttached
                  ? "Keep"
                  : "Keep (none)"
                : mode === "none"
                  ? "Remove"
                  : mode === "url"
                    ? "Replace: URL"
                    : "Replace: PDF"}
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

type MemoStatus = "idle" | "saving" | "saved";

// A minimal per-diagram note: auto-saves (debounced while typing, immediately on
// blur) and shows a subtle, self-hiding "Saved" indicator.
function MemoField({ diagramId, initial }: { diagramId: number; initial: string }) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<MemoStatus>("idle");
  const savedRef = useRef(initial);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-grow with content. Modern browsers do this natively via CSS
  // `field-sizing: content` (see .viewer__memo-input); for others (Safari, older
  // Chrome) sync the height to scrollHeight. Min/max height + scroll are enforced
  // by CSS, so this stays clamped to ~3 rows … 40vh.
  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    autosize();
  }, [value, autosize]);

  const save = useCallback(
    async (next: string) => {
      if (next === savedRef.current) return;
      setStatus("saving");
      try {
        await updateDiagramMemo(diagramId, next);
        savedRef.current = next;
        setStatus("saved");
        if (hideRef.current) clearTimeout(hideRef.current);
        hideRef.current = setTimeout(() => setStatus("idle"), 1800);
      } catch {
        setStatus("idle");
      }
    },
    [diagramId],
  );

  const onChange = (next: string) => {
    setValue(next);
    setStatus("idle");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void save(next), 800);
  };

  const onBlur = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void save(value);
  };

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (hideRef.current) clearTimeout(hideRef.current);
    },
    [],
  );

  return (
    <div className="viewer__memo">
      <textarea
        ref={taRef}
        id={`memo-${diagramId}`}
        className="ssot-input viewer__memo-input"
        rows={3}
        value={value}
        placeholder="Notes about this diagram…"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        spellCheck
      />
      {status !== "idle" && (
        <span className="viewer__memo-status">
          {status === "saving" ? "Saving…" : "Saved"}
        </span>
      )}
    </div>
  );
}
