import { ApiError, getRun, openRunEvents, type RunEventHandlers } from "../api";
import type { RunDetail } from "../types";

// The run-watching sequence shared by the toast watcher (run-watcher.ts) and the
// in-view progress checklist (RunProgress.tsx): prime the run record once, then
// subscribe to its SSE stream, forwarding stage/log/terminal frames. The two
// consumers differ only in thin layers expressed through the options below.
export interface WatchRunHandlers extends RunEventHandlers {
  // The primed run record, before the live stream opens. Lets a consumer read
  // paper status / created_at without a second fetch.
  onPrime?: (run: RunDetail) => void;
  // Called right before the live stream opens (skipped when a terminal run is
  // short-circuited). Used to start an elapsed-time clock, etc.
  onOpen?: () => void;
  // Any getRun failure (including 404). Fires before onMissing.
  onPrimeError?: (error: unknown) => void;
  // The run no longer exists (getRun 404) AND a handler is supplied: the stream is
  // not opened. Without this handler a 404 falls through to the stream like any
  // other transient error.
  onMissing?: () => void;
}

export interface WatchRunOptions {
  // When true, a run already terminal at prime time resolves via onDone/onError
  // and the live stream is NOT opened (the toast watcher only needs the outcome).
  // When false (default), the stream always opens so it can replay persisted
  // stages/logs into an in-view checklist.
  shortCircuitTerminal?: boolean;
}

/**
 * Prime a run then tail its SSE stream. Returns a disposer that stops the stream
 * and prevents any late prime callbacks from firing after unmount.
 */
export function watchRun(
  runId: number,
  handlers: WatchRunHandlers,
  options: WatchRunOptions = {},
): () => void {
  let disposed = false;
  let close: (() => void) | null = null;

  const open = () => {
    if (disposed) return;
    handlers.onOpen?.();
    close = openRunEvents(runId, {
      onStage: handlers.onStage,
      onWarning: handlers.onWarning,
      onLog: handlers.onLog,
      onDone: handlers.onDone,
      onError: handlers.onError,
    });
  };

  void (async () => {
    try {
      const run = await getRun(runId);
      if (disposed) return;
      handlers.onPrime?.(run);
      if (options.shortCircuitTerminal) {
        if (run.status === "done") {
          handlers.onDone?.(run.run_id);
          return;
        }
        if (run.status === "error") {
          handlers.onError?.(
            run.error_kind ?? "agent_failure",
            run.error_detail ?? "The analysis did not complete.",
          );
          return;
        }
      }
    } catch (e) {
      if (disposed) return;
      handlers.onPrimeError?.(e);
      if (e instanceof ApiError && e.status === 404 && handlers.onMissing) {
        handlers.onMissing();
        return;
      }
      // Transient failure (or a 404 with no onMissing handler): the live stream
      // can still resolve the outcome.
    }
    open();
  })();

  return () => {
    disposed = true;
    close?.();
  };
}
