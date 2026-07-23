import { toast } from "sonner";
import { requestCancelConfirm } from "./cancel-bus";
import { watchRun } from "./watch-run";
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
  let clock: number | null = null;
  const stopClock = () => {
    if (clock !== null) {
      window.clearInterval(clock);
      clock = null;
    }
  };

  // Mirror copy-watcher's cancel affordance: the loading toast carries a Cancel
  // action. It opens the shared confirmation modal (safety guard) rather than
  // cancelling directly; the backend records error_kind='cancelled', which the
  // terminal-frame handler below surfaces as a neutral outcome, not a failure.
  const cancelAction = {
    label: "Cancel",
    onClick: () => requestCancelConfirm(runId),
  };

  // A queued interval tick can fire after the terminal toast replaced the
  // loading one (same id) and resurrect it — never render loading past terminal.
  let terminal = false;
  const renderLoading = () => {
    if (terminal) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    toast.loading("Generating diagram", {
      id: toastId,
      description: `${stageLabel(currentStage)} · ${mmss(elapsed)}`,
      duration: Infinity,
      action: cancelAction,
    });
  };

  const showSuccess = () => {
    terminal = true;
    stopClock();
    // Completion is terminal and worth acknowledging: keep it up until the user
    // dismisses it (or clicks through), rather than auto-closing.
    toast.success("Diagram ready", {
      id: toastId,
      duration: Infinity,
      cancel: { label: "Close", onClick: () => toast.dismiss(toastId) },
      action: {
        label: "View diagram",
        onClick: () => {
          onOpenViewer(diagramId, runId);
          toast.dismiss(toastId);
        },
      },
    });
    removeActive(runId);
    watched.delete(runId);
  };

  const showError = (kind: string, detail: string) => {
    terminal = true;
    stopClock();
    // Dismiss the loading toast first — sonner with `richColors` sometimes
    // renders just the icon when a `loading` toast is replaced in-place.
    toast.dismiss(toastId);
    // A user cancellation is a neutral outcome, not a failure: a plain,
    // auto-dismissing toast (mirrors copy-watcher's "Copy cancelled").
    if (kind === "cancelled") {
      toast("Analysis cancelled", { duration: 4000 });
      removeActive(runId);
      watched.delete(runId);
      return;
    }
    toast.error(ERROR_TITLE[kind] ?? "Analysis failed", {
      id: toastId,
      description: detail || undefined,
      duration: Infinity,
      action: { label: "Close", onClick: () => toast.dismiss(toastId) },
    });
    removeActive(runId);
    watched.delete(runId);
  };

  // Prime the run record then tail its SSE stream via the shared core. A run
  // already terminal at prime time short-circuits to showSuccess/showError without
  // opening the stream; a live one starts the elapsed clock (onOpen) and streams.
  watchRun(
    runId,
    {
      onPrime: (detail) => {
        startedAt = new Date(detail.created_at).getTime();
      },
      onOpen: () => {
        renderLoading();
        clock = window.setInterval(renderLoading, 1000);
      },
      onStage: (stage) => {
        currentStage = stage;
        renderLoading();
      },
      onDone: () => showSuccess(),
      onError: (kind, det) => showError(kind, det),
      // A run that no longer exists (e.g. its diagram was deleted) drops out.
      onMissing: () => {
        toast.dismiss(toastId);
        removeActive(runId);
        watched.delete(runId);
      },
    },
    { shortCircuitTerminal: true },
  );
}
