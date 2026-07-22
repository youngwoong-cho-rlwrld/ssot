// Tiny event bridge so the run-watcher toast (which lives OUTSIDE the React tree)
// and in-view buttons share the ONE cancel-confirmation modal hosted in the app
// shell. Both entry points call requestCancelConfirm(runId); App registers the
// handler that opens the modal.

type Handler = (runId: number) => void;

let handler: Handler | null = null;

/** Ask the app shell to open the cancel-confirmation modal for a run. */
export function requestCancelConfirm(runId: number): void {
  handler?.(runId);
}

/** App shell registers (and clears) the single modal opener. */
export function setCancelConfirmHandler(h: Handler | null): void {
  handler = h;
}
