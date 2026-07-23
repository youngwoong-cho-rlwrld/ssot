// THE single source for the chat panel's resizable width, so model-diagram's chat
// column and results-sheet's chat panel default to (and clamp to) the exact same
// values and can never drift. Both apps import these; persistence keys are versioned
// per app so a stale saved width can't reintroduce a mismatch.
export const CHAT_PANEL_WIDTH: { default: number; min: number; max: number } = {
  default: 340,
  min: 280,
  max: 640,
};
