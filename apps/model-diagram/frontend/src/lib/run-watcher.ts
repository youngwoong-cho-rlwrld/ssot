import { toast } from "sonner";
import { ApiError, getRun, openRunEvents } from "../api";
import { ERROR_TITLE, STAGE_LABEL } from "../RunProgress";
import type { Stage } from "../types";

// Mirrors train-eval's copy-checkpoint watcher (lib/copy-watcher.ts): a run's
// notification lives in localStorage while it's active, is resumed on page load,
// and drives a single sonner toast that transitions loading → success/error.
// Where copy-watcher polls a status endpoint, a run has an SSE stream, so that
// is the only swapped part — the structure is otherwise the same.
const STORAGE_KEY = "model-diagram.runs.active";

type ActiveRun = { runId: number; diagramId: number };
type OpenViewer = (diagramId: number, runId: number) => void;

// Dedupe in-process so a remount/hot-reload doesn't spawn N toasts for one run.
const watched = new Set<number>();

function stageLabel(stage: string | null): string {
  if (!stage) return "Starting analysis…";
  return STAGE_LABEL[stage as Stage] ?? stage;
}

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function readActive(): ActiveRun[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x) => x && typeof x.runId === "number" && typeof x.diagramId === "number",
      )
      .map((x) => ({ runId: x.runId, diagramId: x.diagramId }));
  } catch {
    return [];
  }
}

function writeActive(list: ActiveRun[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore quota / private-mode failures — the in-memory watcher still runs
  }
}

function addActive(m: ActiveRun) {
  const list = readActive().filter((x) => x.runId !== m.runId);
  list.push(m);
  writeActive(list);
}

function removeActive(runId: number) {
  writeActive(readActive().filter((x) => x.runId !== runId));
}

export function startRunWatcher(run: ActiveRun, onOpenViewer: OpenViewer) {
  addActive(run);
  void watch(run, onOpenViewer);
}

/** Resume any runs that were generating when the page was loaded/refreshed. */
export function resumeActiveRuns(onOpenViewer: OpenViewer) {
  for (const m of readActive()) {
    if (watched.has(m.runId)) continue;
    void watch(m, onOpenViewer);
  }
}

async function watch({ runId, diagramId }: ActiveRun, onOpenViewer: OpenViewer) {
  if (watched.has(runId)) return;
  watched.add(runId);

  const toastId = `run:${runId}`;
  // Baseline for the elapsed clock; corrected to the run's created_at below so a
  // resumed toast shows true elapsed time, not time-since-reload.
  let startedAt = Date.now();
  let currentStage: string | null = null;

  const renderLoading = () => {
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    toast.loading("Generating diagram", {
      id: toastId,
      description: `${stageLabel(currentStage)} · ${mmss(elapsed)}`,
      duration: Infinity,
    });
  };

  const showSuccess = () => {
    // Completion is terminal and worth acknowledging: keep it up until the user
    // dismisses it (or clicks through), rather than auto-closing.
    toast.success("Diagram ready", {
      id: toastId,
      duration: Infinity,
      closeButton: true,
      action: {
        label: "View diagram",
        onClick: () => {
          onOpenViewer(diagramId, runId);
          toast.dismiss(toastId);
        },
      },
    });
    removeActive(runId);
  };

  const showError = (kind: string, detail: string) => {
    // Dismiss the loading toast first — sonner with `richColors` sometimes
    // renders just the icon when a `loading` toast is replaced in-place.
    toast.dismiss(toastId);
    toast.error(ERROR_TITLE[kind] ?? "Analysis failed", {
      description: detail || undefined,
      duration: Infinity,
      closeButton: true,
    });
    removeActive(runId);
  };

  try {
    const detail = await getRun(runId);
    startedAt = new Date(detail.created_at).getTime();
    if (detail.status === "done") {
      showSuccess();
      watched.delete(runId);
      return;
    }
    if (detail.status === "error") {
      showError(
        detail.error_kind ?? "agent_failure",
        detail.error_detail ?? "The analysis did not complete.",
      );
      watched.delete(runId);
      return;
    }
  } catch (e) {
    // A run that no longer exists (e.g. its diagram was deleted) drops out.
    if (e instanceof ApiError && e.status === 404) {
      toast.dismiss(toastId);
      removeActive(runId);
      watched.delete(runId);
      return;
    }
    // Other errors are transient; the SSE stream can still resolve the outcome.
  }

  renderLoading();
  const clock = window.setInterval(renderLoading, 1000);

  await new Promise<void>((resolve) => {
    openRunEvents(runId, {
      onStage: (stage) => {
        currentStage = stage;
        renderLoading();
      },
      onDone: () => {
        window.clearInterval(clock);
        showSuccess();
        resolve();
      },
      onError: (kind, det) => {
        window.clearInterval(clock);
        showError(kind, det);
        resolve();
      },
    });
  });
  watched.delete(runId);
}
