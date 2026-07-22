import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Upload, X } from "lucide-react";
import { SsotSelect } from "@ssot/ui/SsotSelect";
import {
  ApiError,
  createDiagram,
  createRun,
  getClusters,
  getHealth,
  getModels,
  uploadPaper,
  validate,
} from "./api";
import { ModelSelect } from "./ModelSelect";
import {
  FALLBACK_CLUSTERS,
  type HealthResult,
  type ModelOption,
  type PaperInput,
} from "./types";

type PaperMode = "none" | "url" | "pdf";

interface Prefill {
  diagramId: number;
  cluster: string;
  path: string;
}

interface Props {
  prefill?: Prefill;
  onCancel: () => void;
  onStarted: (diagramId: number, runId: number) => void;
}

export function NewDiagram({ prefill, onCancel, onStarted }: Props) {
  const [clusters, setClusters] = useState<string[]>(FALLBACK_CLUSTERS);
  const [cluster, setCluster] = useState<string>(prefill?.cluster ?? "local");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>("");
  const [path, setPath] = useState(prefill?.path ?? "");
  const [paperMode, setPaperMode] = useState<PaperMode>("none");
  const [paperUrl, setPaperUrl] = useState("");

  // PDF upload state: the file is validated + stored the moment it's picked,
  // yielding a paper_ref we later attach to the diagram.
  const [pdf, setPdf] = useState<{ ref: string; name: string; pages: number } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Field-scoped errors so broken_path / broken_paper surface next to the input
  // that caused them.
  const [pathError, setPathError] = useState<string | null>(null);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runtimes, setRuntimes] = useState<HealthResult["runtimes"] | null>(null);

  // Populate the cluster list and the credentials warning from the backend.
  useEffect(() => {
    const controller = new AbortController();
    getClusters(controller.signal)
      .then((list) => {
        if (list.length > 0) setClusters(list);
      })
      .catch(() => {
        // keep the static fallback list
      });
    getHealth(controller.signal)
      .then((h) => setRuntimes(h.runtimes ?? null))
      .catch(() => {
        // health probe is best-effort; don't block the form
      });
    getModels(controller.signal)
      .then((m) => {
        setModels(m.models);
        // Preselect the backend default; leave empty on failure so the request
        // omits `model` and the backend still applies its own default.
        setModel((prev) => prev || m.default);
      })
      .catch(() => {
        // keep the select empty; the backend default still applies
      });
    return () => controller.abort();
  }, []);

  const clusterOptions = clusters.map((c) => ({ value: c, label: c }));

  const selectedFamily = models.find((m) => m.id === model)?.family;

  // No notice when the selected model's runtime is available. Only surface a
  // warning (inline by the model select) when it ISN'T — no API key / no logged-in
  // CLI for that family. Runtime availability comes from GET /api/health `runtimes`.
  const claudeRt = runtimes?.claude ?? null;
  const codexRt = runtimes?.codex ?? null;
  let modelWarning: string | null = null;
  if (selectedFamily === "codex" && !codexRt) {
    modelWarning = "Codex CLI not available — run `codex login`, then restart the backend.";
  } else if (selectedFamily === "claude" && !claudeRt) {
    modelWarning = "No Claude runtime — set ANTHROPIC_API_KEY or log in to the Claude CLI, then restart the backend.";
  }

  const selectMode = useCallback((mode: PaperMode) => {
    setPaperMode(mode);
    setPaperError(null);
    // Clearing the other channel keeps URL and PDF strictly mutually exclusive.
    if (mode !== "url") setPaperUrl("");
    if (mode !== "pdf") {
      setPdf(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const onPickPdf = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setPaperError(null);
    setPdf(null);
    try {
      const result = await uploadPaper(file);
      setPdf({ ref: result.paper_ref, name: result.filename, pages: result.page_count });
    } catch (err) {
      setPaperError(
        err instanceof ApiError
          ? err.detail || "The PDF could not be validated."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setUploading(false);
    }
  }, []);

  const buildPaper = useCallback((): PaperInput | undefined => {
    if (paperMode === "url" && paperUrl.trim())
      return { kind: "url", url: paperUrl.trim() };
    if (paperMode === "pdf" && pdf) return { kind: "pdf", paper_ref: pdf.ref };
    return undefined;
  }, [paperMode, paperUrl, pdf]);

  const onSubmit = useCallback(async () => {
    setPathError(null);
    setPaperError(null);
    setFormError(null);

    if (!path.trim()) {
      setPathError("Enter the model root path.");
      return;
    }
    if (paperMode === "url" && !paperUrl.trim()) {
      setPaperError("Enter a paper URL, or switch to “No paper”.");
      return;
    }
    if (paperMode === "pdf" && !pdf) {
      setPaperError("Choose a PDF, or switch to “No paper”.");
      return;
    }

    const paper = buildPaper() ?? null;
    const input = { cluster, path: path.trim(), paper, model: model || undefined };
    setSubmitting(true);
    try {
      const check = await validate(input);
      if (!check.ok) {
        if (check.path_error) setPathError(check.detail);
        else if (check.paper_error) setPaperError(check.detail);
        else setFormError(check.detail);
        return;
      }
      if (prefill) {
        const { run_id } = await createRun(prefill.diagramId, input);
        onStarted(prefill.diagramId, run_id);
      } else {
        const { diagram_id, run_id } = await createDiagram(input);
        onStarted(diagram_id, run_id);
      }
    } catch (err) {
      // 400s carry broken_path/broken_paper; route them to the right field.
      if (err instanceof ApiError && err.error === "broken_path") {
        setPathError(err.detail || "The path is unreachable.");
      } else if (err instanceof ApiError && err.error === "broken_paper") {
        setPaperError(err.detail || "The paper could not be read.");
      } else {
        setFormError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }, [cluster, model, path, paperMode, paperUrl, pdf, buildPaper, prefill, onStarted]);

  const busy = submitting || uploading;

  return (
    <section className="panel newdiag">
      <div className="panel__head">
        <button
          type="button"
          className="ssot-icon-btn"
          onClick={onCancel}
          title="Back"
          aria-label="Back to diagrams"
        >
          <ArrowLeft size={15} />
        </button>
        <h2 className="panel__title">{prefill ? "Re-run diagram" : "New diagram"}</h2>
      </div>

      <div className="panel__body newdiag__body">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
        >
          <label className="field">
            <span className="field__label">Cluster</span>
            <SsotSelect
              value={cluster}
              onChange={setCluster}
              options={clusterOptions}
              aria-label="Cluster"
            />
          </label>

          {models.length > 0 && (
            <div className="field">
              <span className="field__label">Model</span>
              <ModelSelect value={model} options={models} onChange={setModel} />
              {modelWarning && <span className="field__err">{modelWarning}</span>}
            </div>
          )}

          <label className="field">
            <span className="field__label">Model root path</span>
            <input
              className="ssot-input"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/rlwrld2/home/…/model"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {pathError && <span className="field__err">{pathError}</span>}
          </label>

          <div className="field">
            <span className="field__label">Source paper (optional)</span>
            <div className="segmented" role="tablist" aria-label="Paper source">
              {(["none", "url", "pdf"] as PaperMode[]).map((mode) => (
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
                  {mode === "none" ? "No paper" : mode === "url" ? "URL" : "PDF"}
                </button>
              ))}
            </div>

            {paperMode === "url" && (
              <input
                className="ssot-input newdiag__paper-input"
                type="url"
                value={paperUrl}
                onChange={(e) => setPaperUrl(e.target.value)}
                placeholder="https://arxiv.org/abs/…"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            )}

            {paperMode === "pdf" && (
              <div className="newdiag__pdf">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="ssot-sr-only"
                  id="paper-pdf"
                  onChange={(e) => void onPickPdf(e.target.files?.[0])}
                />
                <label htmlFor="paper-pdf" className="ssot-btn newdiag__pdf-btn">
                  {uploading ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Upload size={14} />
                  )}
                  {pdf ? pdf.name : "Choose PDF…"}
                </label>
                {pdf && (
                  <>
                    <span className="newdiag__pdf-pages">{pdf.pages} pp</span>
                    <button
                      type="button"
                      className="ssot-icon-btn"
                      onClick={() => selectMode("pdf")}
                      title="Clear file"
                      aria-label="Clear file"
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            )}

            {paperError && <span className="field__err">{paperError}</span>}
          </div>

          {formError && <div className="form__err">{formError}</div>}

          <div className="form__actions">
            <button
              type="button"
              className="ssot-btn"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="ssot-btn ssot-btn-primary"
              disabled={busy}
            >
              {submitting ? <Loader2 size={14} className="spin" /> : null}
              {prefill ? "Start run" : "Create diagram"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
